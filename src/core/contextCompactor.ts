/**
 * @file src/core/contextCompactor.ts
 * Enterprise-Grade Context Compactor (OpenAI Codex & Claude Code Architecture).
 *
 * Provides:
 * 1. High-fidelity structured state summarization (Goal, Architecture, Files, Milestones, Next Steps).
 * 2. Non-destructive physical in-place compaction preserving root anchor and recent turns.
 * 3. Proactive auto-compaction before context limits or token budgets choke execution.
 * 4. User-facing `/compact` slash-command handler.
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

export interface CompactionOptions {
  readonly keepRecentTurns?: number;
  readonly taskId?: string;
  readonly originalPrompt?: string;
  readonly maxCharPool?: number;
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
 * Extracts a high-fidelity, structured state summary from dropped message history.
 * Mirrors the state preservation architecture of OpenAI Codex and Claude Code.
 */
export function buildCodexStyleSummary(
  droppedMessages: readonly ToolObservation[],
  originalPrompt?: string
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
              const target = String(parsed.path || parsed.file_path || parsed.target || '');
              if (target) {
                if (['fs_write', 'write_to_file', 'writeFile'].includes(fnName)) {
                  createdFiles.add(target);
                } else if (['fs_edit', 'replace_file_content', 'multi_replace_file_content'].includes(fnName)) {
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

  // Build the Codex-style structured report
  const sections: string[] = [];

  sections.push('### [COMPACTED CONTEXT CHECKPOINT — CODEX STATE PRESERVATION]');

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

  // Calculate split index for physical compaction:
  // Messages from index 1 to splitIndex will be collapsed into a single summary
  const splitIndex = messages.length - keepRecentTurns - 1;
  if (splitIndex < 1) {
    return {
      compacted: false,
      removedCount: 0,
      reclaimedChars: 0,
      reclaimedTokens: 0,
      initialChars,
      finalChars: measureMessages(messages),
      summaryText: '',
      reason: 'Split index out of range.'
    };
  }

  const dropped = messages.slice(1, splitIndex + 1);
  const rootPrompt = typeof messages[0]?.content === 'string'
    ? messages[0].content
    : options.originalPrompt;

  const structuredSummary = buildCodexStyleSummary(dropped, rootPrompt);
  const fullRecoverableSummary = buildRecoverableDroppedSummary(dropped, structuredSummary);

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

  const thresholdFraction = options.thresholdFraction ?? 0.70;
  const currentChars = measureMessages(loop.messages);
  const maxPool = loop._contextLimitChars || 120_000;

  if (currentChars >= maxPool * thresholdFraction) {
    const result = compactSessionMessages(loop.messages, {
      keepRecentTurns: 4,
      taskId: loop.taskId,
      originalPrompt: loop.currentTaskPrompt || loop.userPrompt
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
 * Slash command handler for `/compact`.
 */
export async function runCompactSlashCommand(
  _argv: string[],
  ctx: { loop?: any; prompt?: any }
): Promise<{ ok: boolean; output: string }> {
  const loop = ctx.loop;
  if (!loop || !Array.isArray(loop.messages) || loop.messages.length === 0) {
    return {
      ok: false,
      output: 'No active session or conversation messages to compact.'
    };
  }

  if (loop.messages.length <= 3) {
    return {
      ok: true,
      output: `Conversation currently contains only ${loop.messages.length} message(s). Compaction is not needed yet.`
    };
  }

  const result = compactSessionMessages(loop.messages, {
    keepRecentTurns: 4,
    taskId: loop.taskId || 'manual-compact',
    originalPrompt: loop.currentTaskPrompt || loop.userPrompt
  });

  if (!result.compacted) {
    return {
      ok: true,
      output: result.reason || 'Context already compact. No older messages eligible for compaction.'
    };
  }

  if (loop.memoryManager && typeof loop.memoryManager.saveHistory === 'function') {
    loop.memoryManager.saveHistory(loop.messages);
  }

  const reclaimedKb = (result.reclaimedChars / 1024).toFixed(1);
  const finalKb = (result.finalChars / 1024).toFixed(1);

  const report = [
    '✔ Context successfully compacted (OpenAI Codex structured state model).',
    '',
    `  • Earlier messages condensed: ${result.removedCount}`,
    `  • Memory reclaimed: ${reclaimedKb} KB (~${result.reclaimedTokens.toLocaleString()} tokens)`,
    `  • Live active context: ${finalKb} KB`,
    '  • Golden Anchor (original prompt) & recent working turns: Preserved in full',
    '  • Deliverables and source files on disk: 100% intact',
    '',
    'The agent will continue with a clean, focused context without losing prior achievements.'
  ].join('\n');

  return { ok: true, output: report };
}
