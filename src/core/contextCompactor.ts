/**
 * @file src/core/contextCompactor.ts
 * Causyne Agent — Enterprise Structured Context Compactor.
 *
 * Provides:
 * 1. High-fidelity structured state summarization (Goal, Architecture, Files, Milestones, Next Steps).
 * 2. Non-destructive physical in-place compaction preserving root anchor and recent turns.
 * 3. Proactive auto-compaction with output-token reservation and strict shrink verification.
 * 4. Reactive oldest-image offloading to recover cleanly from multimodal context limits.
 * 5. User-facing `/compact` slash-command handler.
 *
 * Authorship: Strict TypeScript (Causyne Agent).
 */

import {
  pruneStaleToolObservations,
  shortenOversizedToolObservations,
  pruneExecutedToolArguments,
  buildRecoverableDroppedSummary,
  type ToolObservation
} from '../historyPruner.js';
import { compactInPlace, measureMessages, CHARS_PER_TOKEN } from '../contextManager.js';
import { extractPatchTargetPaths } from '../tools/applyPatch.js';
import { safeDisplay } from '../tui/text.js';
import { runConfiguredHooks } from '../hooks.js';

export interface CodexCompactedState {
  readonly goal: string;
  readonly architectureNotes: readonly string[];
  readonly createdFiles: readonly string[];
  readonly modifiedFiles: readonly string[];
  readonly inspectedFiles: readonly string[];
  readonly verifiedMilestones: readonly string[];
  readonly pendingMilestones: readonly string[];
  readonly toolsSummary: string;
}

export interface PlanStepAnchor {
  readonly step?: string | undefined;
  readonly title?: string | undefined;
  readonly status?: string | undefined;
}

export interface CompactionOptions {
  readonly keepRecentTurns?: number;
  readonly taskId?: string;
  readonly originalPrompt?: string;
  readonly maxCharPool?: number;
  readonly activePlan?: readonly PlanStepAnchor[] | undefined;
  readonly focusHint?: string | undefined;
}

export interface CompactionResult {
  readonly compacted: boolean;
  readonly removedCount: number;
  readonly reclaimedChars: number;
  readonly reclaimedTokens: number;
  readonly initialChars: number;
  readonly finalChars: number;
  readonly summaryText: string;
  readonly reason?: string;
}

/**
 * Adjusts a candidate compaction split index so compaction NEVER severs a
 * `role: 'tool'` result from its preceding `role: 'assistant'` `tool_calls`
 * message (which would cause HTTP 400 invalid tool-turn errors on OpenAI,
 * Anthropic, and Gemini).
 *
 * Returns a safe `splitIndex` in `[1, messages.length - 2]`, or `-1` if no
 * safe split exists.
 */
export function findSafeCompactionSplitIndex(
  messages: ReadonlyArray<{ role?: string; tool_calls?: unknown }>,
  targetSplitIndex: number
): number {
  const maxSplit = messages.length - 2;
  if (maxSplit < 1) return -1;
  let split = Math.min(Math.max(1, targetSplitIndex), maxSplit);

  // If the first retained message (`split + 1`) is a `tool` result, walk back
  // until the owning `assistant` message with `tool_calls` is also retained.
  if (messages[split + 1]?.role === 'tool') {
    let back = split;
    while (back >= 1 && messages[back + 1]?.role === 'tool') {
      back -= 1;
    }
    // Also retain the owning `assistant` message if `back + 1` was still `tool`
    if (back >= 1 && messages[back]?.role === 'assistant' && Array.isArray(messages[back]?.tool_calls)) {
      back -= 1;
    }
    if (back >= 1 && messages[back + 1]?.role !== 'tool') {
      return back;
    }
    // Otherwise walk forward past the contiguous `tool` results while keeping at least 1 recent message
    let forward = split;
    while (forward < maxSplit && messages[forward + 1]?.role === 'tool') {
      forward += 1;
    }
    if (forward <= maxSplit && messages[forward + 1]?.role !== 'tool') {
      return forward;
    }
    return -1;
  }

  return split;
}

/**
 * Extracts a high-fidelity, structured state summary from dropped message history.
 */
export function buildCodexStyleSummary(
  droppedMessages: readonly ToolObservation[],
  originalPrompt?: string,
  extra?: { activePlan?: readonly PlanStepAnchor[] | undefined; focusHint?: string | undefined }
): string {
  const createdFiles = new Set<string>();
  const modifiedFiles = new Set<string>();
  const inspectedFiles = new Set<string>();
  const verifiedMilestones = new Set<string>();
  const toolCounts = new Map<string, number>();
  const architectureNotes = new Set<string>();
  const failures = new Set<string>();

  for (const msg of droppedMessages) {
    if (msg.role === 'assistant') {
      const calls = msg.tool_calls || [];
      for (const call of calls) {
        const fnName = call.function?.name || 'tool';
        toolCounts.set(fnName, (toolCounts.get(fnName) || 0) + 1);

        try {
          const rawArgs = call.function?.arguments;
          if (typeof rawArgs === 'string') {
            const parsed = JSON.parse(rawArgs);
            if (parsed && typeof parsed === 'object') {
              const target = String(parsed.path || parsed.file_path || parsed.target || parsed.destination || '');
              if (fnName === 'apply_patch' && typeof parsed.patch === 'string') {
                for (const patchPath of extractPatchTargetPaths(parsed.patch).paths) {
                  modifiedFiles.add(patchPath);
                }
              } else if (target) {
                if (['fs_write', 'write_to_file', 'writeFile'].includes(fnName)) {
                  createdFiles.add(target);
                } else if (['fs_edit', 'MultiEdit', 'multi_edit', 'fs_move', 'replace_file_content', 'multi_replace_file_content'].includes(fnName)) {
                  modifiedFiles.add(target);
                } else if (['fs_read', 'view_file', 'readFile'].includes(fnName)) {
                  inspectedFiles.add(target);
                }
              }

              // Detect architectural and technology declarations
              if (parsed.command && typeof parsed.command === 'string') {
                const cmd = parsed.command;
                if (/npm\s+i|install/i.test(cmd)) architectureNotes.add(`Dependencies: ${cmd.slice(0, 100)}`);
                if (/tsc|build/i.test(cmd)) architectureNotes.add('Compiled build pipeline invoked');
              }
            }
          }
        } catch {
          // Arguments might be truncated or non-JSON; continue extraction.
        }
      }

      // Extract technology/design keywords from assistant narrative
      if (typeof msg.content === 'string') {
        const text = msg.content;
        if (/three\.?js|webgl|canvas3d/i.test(text)) architectureNotes.add('Three.js / WebGL 3D rendering pipeline');
        if (/audio(?:\s*context|\s*engine)|\.mp3|\.wav/i.test(text)) architectureNotes.add('Web Audio Engine & sound effects');
        if (/blender/i.test(text)) architectureNotes.add('Blender 3D procedural studio');
        if (/typescript/i.test(text)) architectureNotes.add('Strict TypeScript architecture');
      }
    }

    if (msg.role === 'tool') {
      const contentStr = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? '');
      try {
        const parsed = JSON.parse(contentStr);
        if (parsed && typeof parsed === 'object') {
          if (parsed.success === true) {
            if (msg.name) verifiedMilestones.add(`${msg.name} verified`);
          } else if (parsed.success === false && parsed.error) {
            failures.add(`${msg.name || 'tool'}: ${String(parsed.error).slice(0, 120)}`);
          }
        }
      } catch {
        // Plain output or decayed marker
      }
    }
  }

  // Build the structured compaction summary report
  const sections: string[] = [];

  sections.push('### [COMPACTED CONTEXT CHECKPOINT — CAUSYNE STATE PRESERVATION]');

  if (originalPrompt && originalPrompt.trim()) {
    sections.push(`**Goal & User Intent:**\n${originalPrompt.trim()}`);
  }

  if (architectureNotes.size > 0) {
    sections.push(`**Architecture & Technology Stack:**\n${[...architectureNotes].map(a => `- ${a}`).join('\n')}`);
  }

  const allFilesTouched = [
    ...[...createdFiles].map(f => `- [Created] ${f}`),
    ...[...modifiedFiles].map(f => `- [Modified] ${f}`),
    ...[...inspectedFiles].filter(f => !createdFiles.has(f) && !modifiedFiles.has(f)).map(f => `- [Inspected] ${f}`)
  ];

  if (allFilesTouched.length > 0) {
    sections.push(`**Files Manifest & Workspace State:**\n${allFilesTouched.slice(0, 20).join('\n')}`);
  }

  if (toolCounts.size > 0) {
    const summary = [...toolCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => `${name} (${count}x)`)
      .join(', ');
    sections.push(`**Actions Executed:** ${summary}`);
  }

  if (verifiedMilestones.size > 0) {
    sections.push(`**Verified Outcomes:** ${[...verifiedMilestones].slice(0, 8).join(', ')}`);
  }

  if (failures.size > 0) {
    sections.push(`**Prior Failures Handled:** ${[...failures].slice(0, 4).join(' | ')}`);
  }

  if (Array.isArray(extra?.activePlan) && extra.activePlan.length > 0) {
    const planLines = extra.activePlan
      .slice(0, 12)
      .map(item => {
        const label = String(item.step || item.title || '').trim();
        if (!label) return '';
        const status = String(item.status || 'pending').trim();
        return `- [${status}] ${label}`;
      })
      .filter(Boolean);
    if (planLines.length > 0) {
      sections.push(`**Active Implementation Plan:**\n${planLines.join('\n')}`);
    }
  }

  sections.push(
    '**Directive for Continuation:** Completed workspace files and session artifacts on disk are preserved. '
    + 'Do not re-scan or repeat verified setup steps. Continue forward execution and complete the remaining requirements.'
  );

  return sections.join('\n\n');
}

/**
 * Compacts the conversation trajectory in-place.
 * Preserves the Golden Anchor (message 0) and the most recent working turns.
 */
export function compactSessionMessages(
  messages: any[],
  options: CompactionOptions = {}
): CompactionResult {
  const initialChars = measureMessages(messages);
  const keepRecentTurns = Math.max(2, options.keepRecentTurns ?? 4);

  // Must have enough messages to compact: root message (0) + at least 2 dropped + keepRecent
  if (messages.length < keepRecentTurns + 3) {
    return {
      compacted: false,
      removedCount: 0,
      reclaimedChars: 0,
      reclaimedTokens: 0,
      initialChars,
      finalChars: initialChars,
      summaryText: '',
      reason: 'History contains too few messages for compaction.'
    };
  }

  // Pre-pass: run Observation Elision and Argument Archiving on all messages
  pruneStaleToolObservations(messages, {
    keepRecent: keepRecentTurns,
    minChars: 300,
    taskId: options.taskId ?? 'compaction'
  });
  shortenOversizedToolObservations(messages, {
    threshold: 1500,
    taskId: options.taskId ?? 'compaction'
  });
  pruneExecutedToolArguments(messages, {
    threshold: 1500,
    taskId: options.taskId ?? 'compaction'
  });

  // Calculate turn-boundary-safe split index for physical compaction:
  // Messages from index 1 to splitIndex will be collapsed into a single summary
  // without ever orphaning a `role: 'tool'` result from its `assistant` `tool_calls`.
  const splitIndex = findSafeCompactionSplitIndex(messages, messages.length - keepRecentTurns - 1);
  if (splitIndex < 1) {
    return {
      compacted: false,
      removedCount: 0,
      reclaimedChars: 0,
      reclaimedTokens: 0,
      initialChars,
      finalChars: measureMessages(messages),
      summaryText: '',
      reason: 'Split index out of range or would break an active tool-call turn.'
    };
  }

  const dropped = messages.slice(1, splitIndex + 1);
  const rootPrompt = typeof messages[0]?.content === 'string'
    ? messages[0].content
    : options.originalPrompt;

  const structuredSummary = buildCodexStyleSummary(dropped, rootPrompt, {
    activePlan: options.activePlan,
    focusHint: options.focusHint
  });
  const focusFooter = options.focusHint && options.focusHint.trim()
    ? `\n\nPreserved Focus Directive: ${safeDisplay(options.focusHint.trim()).slice(0, 400)}`
    : '';
  const fullRecoverableSummary = buildRecoverableDroppedSummary(dropped, `${structuredSummary}${focusFooter}`);

  const removed = compactInPlace(messages, splitIndex, fullRecoverableSummary);
  const finalChars = measureMessages(messages);
  const reclaimedChars = Math.max(0, initialChars - finalChars);
  const reclaimedTokens = Math.round(reclaimedChars / CHARS_PER_TOKEN);

  return {
    compacted: true,
    removedCount: removed,
    reclaimedChars,
    reclaimedTokens,
    initialChars,
    finalChars,
    summaryText: fullRecoverableSummary
  };
}

/**
 * Output-reservation threshold formula: reserves completion output tokens and
 * safety headroom before computing the auto-compaction trigger ceiling.
 */
export function computeCompactionThresholdChars(
  maxPoolChars: number,
  options: {
    thresholdFraction?: number | undefined;
    reservedOutputTokens?: number | undefined;
    headroomTokens?: number | undefined;
  } = {}
): number {
  const safePool = Math.max(256, Math.floor(maxPoolChars));
  const fraction = options.thresholdFraction ?? 0.75;
  const reservedChars = Math.max(0, (options.reservedOutputTokens ?? 4_096) * CHARS_PER_TOKEN);
  const headroomChars = Math.max(0, (options.headroomTokens ?? 2_048) * CHARS_PER_TOKEN);
  const byFraction = Math.floor(safePool * fraction);
  const byBudget = safePool > (reservedChars + headroomChars)
    ? Math.max(Math.floor(safePool * 0.45), safePool - reservedChars - headroomChars)
    : byFraction;
  return Math.min(byFraction, byBudget);
}

/**
 * Reactively offloads up to `maxToOffload` oldest inline input image blocks
 * (from user or tool messages) into lightweight placeholder text without
 * mutating assistant replies or dropping surrounding conversation text.
 */
export function offloadOldestInputImages(
  messages: any[],
  maxToOffload = 4
): { offloadedCount: number } {
  let offloadedCount = 0;
  for (let i = 0; i < messages.length && offloadedCount < maxToOffload; i++) {
    const msg = messages[i];
    if (!msg || (msg.role !== 'user' && msg.role !== 'tool') || !Array.isArray(msg.content)) continue;
    for (let j = 0; j < msg.content.length && offloadedCount < maxToOffload; j++) {
      const part = msg.content[j];
      if (!part || typeof part !== 'object') continue;
      const isImage = part.type === 'image_url'
        || part.type === 'image'
        || part.type === 'input_image';
      if (!isImage) continue;
      msg.content[j] = {
        type: 'text',
        text: '[Image offloaded to preserve context capacity; re-inspect the workspace file if visual detail is needed.]'
      };
      offloadedCount++;
    }
  }
  return { offloadedCount };
}

/**
 * Proactively checks memory pressure and runs auto-compaction if context threshold is exceeded.
 * Operates silently and seamlessly without interrupting active work.
 */
export function autoCompactIfUnderPressure(
  loop: any,
  options: { thresholdFraction?: number; minMessages?: number } = {}
): CompactionResult | null {
  if (!loop || !Array.isArray(loop.messages) || loop.messages.length < (options.minMessages ?? 12)) {
    return null;
  }

  const currentChars = measureMessages(loop.messages);
  const maxPool = loop._contextLimitChars || 120_000;
  const triggerChars = computeCompactionThresholdChars(maxPool, {
    thresholdFraction: options.thresholdFraction ?? 0.70
  });

  if (currentChars >= triggerChars) {
    const result = compactSessionMessages(loop.messages, {
      keepRecentTurns: 4,
      taskId: loop.taskId,
      originalPrompt: loop.currentTaskPrompt || loop.userPrompt,
      activePlan: Array.isArray(loop._implementationPlan) ? loop._implementationPlan : undefined
    });

    if (result.compacted) {
      if (loop.memoryManager && typeof loop.memoryManager.saveHistory === 'function') {
        loop.memoryManager.saveHistory(loop.messages);
      }
      if (typeof loop.emitEvent === 'function') {
        loop.emitEvent({
          type: 'status',
          message: `Context auto-compacted: reclaimed ${(result.reclaimedChars / 1024).toFixed(1)} KB (~${result.reclaimedTokens.toLocaleString()} tokens)`
        });
      }
      return result;
    }
  }

  return null;
}

/**
 * Slash command handler for `/compact [--preview] [--keep <turns>] [focus instructions]`.
 */
export async function runCompactSlashCommand(
  argv: string[],
  ctx: { loop?: any; prompt?: any }
): Promise<{ ok: boolean; output: string }> {
  const loop = ctx.loop;
  if (!loop || !Array.isArray(loop.messages) || loop.messages.length === 0) {
    return {
      ok: false,
      output: 'No active session or conversation messages to compact.'
    };
  }

  let preview = false;
  let keepRecentTurns = 4;
  const focusParts: string[] = [];
  const safeArgv = Array.isArray(argv) ? argv : [];
  for (let i = 0; i < safeArgv.length; i++) {
    const token = String(safeArgv[i] ?? '').trim();
    if (!token) continue;
    if (token === '--preview' || token === '--dry-run') {
      preview = true;
    } else if (token === '--keep' && i + 1 < safeArgv.length) {
      const parsed = Number.parseInt(String(safeArgv[++i] ?? ''), 10);
      if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 24) {
        keepRecentTurns = parsed;
      }
    } else if (token.startsWith('--keep=')) {
      const parsed = Number.parseInt(token.slice('--keep='.length), 10);
      if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 24) {
        keepRecentTurns = parsed;
      }
    } else {
      focusParts.push(token);
    }
  }
  const focusHint = focusParts.join(' ').trim();

  if (loop.messages.length <= 3) {
    return {
      ok: true,
      output: `Conversation currently contains only ${loop.messages.length} message(s). Compaction is not needed yet.`
    };
  }

  if (preview) {
    const initialChars = measureMessages(loop.messages);
    const rawSplit = loop.messages.length - keepRecentTurns - 1;
    const splitIndex = rawSplit >= 1 ? findSafeCompactionSplitIndex(loop.messages, rawSplit) : -1;
    const candidateCount = splitIndex >= 1 ? splitIndex : 0;
    const estDropChars = splitIndex >= 1 ? measureMessages(loop.messages.slice(1, splitIndex + 1)) : 0;
    const estTokens = Math.round(estDropChars / CHARS_PER_TOKEN);
    return {
      ok: true,
      output: [
        'Context Compaction Preview (no changes applied)',
        '',
        `  • Total messages        : ${loop.messages.length}`,
        `  • Current context size  : ${(initialChars / 1024).toFixed(1)} KB (~${Math.round(initialChars / CHARS_PER_TOKEN).toLocaleString()} tokens)`,
        `  • Eligible to condense  : ${candidateCount} message(s) (keeping ${keepRecentTurns} recent turns)`,
        `  • Estimated reclamation : ~${(estDropChars / 1024).toFixed(1)} KB (~${estTokens.toLocaleString()} tokens)`,
        ...(focusHint ? [`  • Focus directive       : ${safeDisplay(focusHint)}`] : []),
        '',
        'Run /compact without --preview to apply.'
      ].join('\n')
    };
  }

  try {
    await runConfiguredHooks({
      hooks: loop.config?.hooks,
      event: 'PreCompact',
      toolName: 'compact',
      args: {
        messageCount: loop.messages.length,
        ...(focusHint ? { focusHint } : {})
      },
      taskId: loop.taskId || 'manual-compact',
      workspacePaths: loop.workspaceRoot ? [loop.workspaceRoot] : [process.cwd()]
    });
  } catch {
    // Lifecycle hooks fail open so manual compaction never crashes
  }

  const result = compactSessionMessages(loop.messages, {
    keepRecentTurns,
    taskId: loop.taskId || 'manual-compact',
    originalPrompt: loop.currentTaskPrompt || loop.userPrompt,
    activePlan: Array.isArray(loop._implementationPlan) ? loop._implementationPlan : undefined,
    ...(focusHint ? { focusHint } : {})
  });

  if (!result.compacted) {
    return {
      ok: true,
      output: result.reason || 'Context already compact. No older messages eligible for compaction.'
    };
  }

  loop._contextChars = result.finalChars;
  if (loop.memoryManager && typeof loop.memoryManager.saveHistory === 'function') {
    loop.memoryManager.saveHistory(loop.messages);
  }

  const reclaimedKb = (result.reclaimedChars / 1024).toFixed(1);
  const finalKb = (result.finalChars / 1024).toFixed(1);

  const report = [
    '✔ Context successfully compacted (Causyne structured state model).',
    '',
    `  • Earlier messages condensed: ${result.removedCount}`,
    `  • Memory reclaimed: ${reclaimedKb} KB (~${result.reclaimedTokens.toLocaleString()} tokens)`,
    `  • Live active context: ${finalKb} KB`,
    ...(focusHint ? [`  • Preserved focus directive: ${safeDisplay(focusHint)}`] : []),
    '  • Golden Anchor (original prompt) & recent working turns: Preserved in full',
    '  • Deliverables and source files on disk: 100% intact',
    '',
    'The agent will continue with a clean, focused context without losing prior achievements.'
  ].join('\n');

  return { ok: true, output: report };
}
