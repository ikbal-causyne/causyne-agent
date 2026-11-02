/**
 * @file src/memory/episodicStore.ts
 * Causyne Sovereign Episodic Memory Store:
 * - Zero-LLM deterministic tool observation compiler (`compileToolObservation`)
 * - `<private>...</private>` tag stripping and credential redaction (`redactPrivateAndSecrets`)
 * - 2-Tier IDF-Veto near-duplicate merging with ACT-R reinforcement (`recordObservation`)
 * - 3-Layer Progressive Memory Disclosure (`searchIndex`, `getTimelineWindow`, `getObservationsByIds`)
 * - ACT-R strength-ranked startup context builder with `fitEpisodicContextToBudget`
 * - Auto-detection bridge for external SQLite memory archives (`~/.causyne/memory-archive.db`)
 *
 * Authorship: Strict TypeScript (Causyne Agent).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { causyneHome } from '../utils/paths.js';
import { computeObservationStrength, rankObservationsByStrength } from './actrRanker.js';
import { DEFAULT_EPISODIC_BUDGET_CHARS, fitEpisodicContextToBudget } from './contextBudget.js';
import { buildCorpusIdfMap, decideNearDuplicate, tokenizeForDedup } from './nearDuplicate.js';
import type {
  EpisodicObservation,
  EpisodicSessionSummary,
  ObservationBatchResult,
  ObservationType,
  ProgressiveSearchResult,
  ProgressiveSearchRow,
  TimelineWindowItem,
  TimelineWindowResult
} from './episodicTypes.js';

export const PROGRESSIVE_MAX_BYTES = 64 * 1024;
const MAX_OBSERVATIONS_PER_PROJECT = 400;
const MAX_SUMMARIES_PER_PROJECT = 80;
const MAX_REINFORCEMENT_TIMESTAMPS = 32;

interface PersistedEpisodicData {
  schemaVersion: number;
  nextObservationId: number;
  nextSummaryId: number;
  observations: EpisodicObservation[];
  summaries: EpisodicSessionSummary[];
}

export interface RecordObservationInput {
  readonly taskId: string;
  readonly workspace: string;
  readonly type: ObservationType;
  readonly title: string;
  readonly subtitle?: string | undefined;
  readonly narrative: string;
  readonly facts?: readonly string[] | undefined;
  readonly concepts?: readonly string[] | undefined;
  readonly filesRead?: readonly string[] | undefined;
  readonly filesModified?: readonly string[] | undefined;
  readonly toolName: string;
  readonly createdAtEpochMs?: number | undefined;
  readonly source?: 'native' | 'external_bridge' | undefined;
}

export interface SearchEpisodicOptions {
  readonly query?: string | undefined;
  readonly workspace?: string | undefined;
  readonly project?: string | undefined;
  readonly type?: ObservationType | 'summary' | undefined;
  readonly limit?: number | undefined;
  readonly workspaceOnly?: boolean | undefined;
  readonly nowMs?: number | undefined;
}

export interface TimelineQueryOptions {
  readonly anchorId: string | number;
  readonly workspace?: string | undefined;
  readonly depthBefore?: number | undefined;
  readonly depthAfter?: number | undefined;
}

/**
 * Strip `<private>...</private>` tags and redact API keys, bearer tokens, and secrets.
 */
export function redactPrivateAndSecrets(input: string): string {
  if (!input) return '';
  return String(input)
    .replace(/<private>[\s\S]*?<\/private>/gi, '[REDACTED_PRIVATE]')
    .replace(/\b(sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{25,})\b/g, '[REDACTED_KEY]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[REDACTED_TOKEN]')
    .replace(/((?:api[_-]?key|token|secret|password)\s*[:=]\s*["']?)[^\s"',;]{8,}/gi, '$1[REDACTED]')
    .trim();
}

/**
 * Derive a clean project name from a workspace path.
 */
export function projectFromWorkspace(workspace: string): string {
  const trimmed = String(workspace || '').trim();
  if (!trimmed) return 'default';
  const base = path.basename(path.resolve(trimmed));
  return base || 'default';
}

const LOW_SIGNAL_READ_TOOLS: ReadonlySet<string> = new Set([
  'fs_list', 'fs_find', 'process_list', 'check_system_specs', 'tool_search'
]);

/**
 * Deterministically compile a completed tool execution into a structured observation input,
 * or return `null` if the tool call is low-signal noise that should not clutter memory.
 */
export function compileToolObservation(params: {
  taskId: string;
  workspace: string;
  toolName: string;
  args: Record<string, unknown>;
  result: Record<string, unknown> | null | undefined;
  nowMs?: number | undefined;
}): RecordObservationInput | null {
  const { taskId, workspace, toolName, args, result } = params;
  const normalizedTool = String(toolName || '').trim();
  if (!normalizedTool || LOW_SIGNAL_READ_TOOLS.has(normalizedTool)) {
    return null;
  }

  const isSuccess = result ? (result.success !== false && !result.error) : true;
  if (!isSuccess) {
    // Only record failed verification or build commands as bugfix discoveries; skip transient tool errors
    const cmd = typeof args.command === 'string' ? args.command : typeof args.cmd === 'string' ? args.cmd : '';
    if (!cmd || !/\b(test|build|tsc|typecheck|lint|pytest|cargo)\b/i.test(cmd)) {
      return null;
    }
  }

  const rawPath = String(
    args.path ?? args.file_path ?? args.filePath ?? args.target ?? ''
  ).trim();
  const relPath = rawPath && workspace
    ? (path.isAbsolute(rawPath) ? path.relative(workspace, rawPath) : rawPath)
    : rawPath;

  const lowerTool = normalizedTool.toLowerCase();

  // 1. File mutations (fs_write, fs_edit, MultiEdit, write_file, edit_file)
  if (['fs_write', 'fs_edit', 'multiedit', 'write_file', 'edit_file', 'replace_file_content', 'write', 'edit'].includes(lowerTool)) {
    if (!relPath) return null;
    const isNewWrite = lowerTool === 'fs_write' || lowerTool === 'write_file' || lowerTool === 'write';
    const type: ObservationType = isNewWrite
      ? 'feature'
      : /\b(fix|bug|patch|error|repair)\b/i.test(String(args.Replacement ?? args.content ?? ''))
        ? 'bugfix'
        : 'refactor';
    const actionVerb = isNewWrite ? 'Authored' : 'Updated';
    const snippetSource = String(args.Replacement ?? args.content ?? '').slice(0, 320);
    const cleanSnippet = redactPrivateAndSecrets(snippetSource).replace(/\s+/g, ' ').trim();
    return {
      taskId,
      workspace,
      type,
      title: `${actionVerb} ${relPath}`,
      subtitle: `${normalizedTool} on ${relPath}`,
      narrative: cleanSnippet
        ? `${actionVerb} file ${relPath} via ${normalizedTool}. Key content: ${cleanSnippet.slice(0, 220)}`
        : `${actionVerb} file ${relPath} via ${normalizedTool}.`,
      facts: [`Modified ${relPath}`],
      concepts: [type, path.extname(relPath).replace(/^\./, '') || 'file'],
      filesRead: [],
      filesModified: [relPath],
      toolName: normalizedTool,
      ...(params.nowMs !== undefined ? { createdAtEpochMs: params.nowMs } : {})
    };
  }

  // 2. Shell & Verification commands (sysRun, bash, run_command)
  if (['sysrun', 'bash', 'run_command', 'execute', 'terminal_persistent_shell'].includes(lowerTool)) {
    const command = redactPrivateAndSecrets(
      String(args.command ?? args.cmd ?? '').trim()
    );
    if (!command) return null;
    // Skip read-only shell probes and ad-hoc inspection one-liners so episodic memory stays high-signal
    if (/^(?:ls|pwd|cd|cat|head|tail|echo|which|true|find|wc|grep|egrep|fgrep|rg|sed|awk|jq|stat|file|nl|sort|uniq|cut|tr)\b/i.test(command)) {
      return null;
    }
    if (/^(?:node\s+-e|python3?\s+-c|git\s+(?:status|log|diff|show|branch|rev-parse))\b/i.test(command)) {
      return null;
    }
    const isVerify = /\b(test|build|tsc|typecheck|lint|pytest|cargo|go\s+test|check|vitest|jest|gradle)\b/i.test(command);
    const isHighSignalAction = isVerify || /\b(install|commit|deploy|migrate|publish|docker|rsync|cmake|make)\b/i.test(command);
    if (!isHighSignalAction) {
      return null;
    }
    const type: ObservationType = isVerify ? 'verification' : 'discovery';
    const statusWord = isSuccess ? 'Succeeded' : 'Failed';
    const outputPreview = redactPrivateAndSecrets(
      String(result?.output ?? result?.stdout ?? result?.error ?? '').slice(0, 240)
    ).replace(/\s+/g, ' ').trim();
    return {
      taskId,
      workspace,
      type,
      title: `${statusWord}: ${command.slice(0, 80)}`,
      subtitle: `${normalizedTool} (${statusWord.toLowerCase()})`,
      narrative: outputPreview
        ? `Command \`${command.slice(0, 120)}\` ${statusWord.toLowerCase()}: ${outputPreview}`
        : `Command \`${command.slice(0, 120)}\` ${statusWord.toLowerCase()}.`,
      facts: [`Command: ${command.slice(0, 100)} (${statusWord.toLowerCase()})`],
      concepts: [type, 'command'],
      filesRead: [],
      filesModified: [],
      toolName: normalizedTool,
      ...(params.nowMs !== undefined ? { createdAtEpochMs: params.nowMs } : {})
    };
  }

  // 3. Browser / Visual Verification
  if (['browser_act', 'screenshot', 'vision_inspect_ui'].includes(lowerTool)) {
    const action = String(args.action ?? 'verify').trim();
    return {
      taskId,
      workspace,
      type: 'verification',
      title: `Verified UI via ${normalizedTool} (${action})`,
      subtitle: `${normalizedTool} ${action}`,
      narrative: `Executed UI/browser verification step using ${normalizedTool} (${action}).`,
      facts: [`Verified UI with ${normalizedTool}`],
      concepts: ['verification', 'ui'],
      filesRead: relPath ? [relPath] : [],
      filesModified: [],
      toolName: normalizedTool,
      ...(params.nowMs !== undefined ? { createdAtEpochMs: params.nowMs } : {})
    };
  }

  // 4. Architecture Decisions & Explicit Memory Writes
  if (lowerTool === 'request_decision' || lowerTool === 'memory_write') {
    const text = redactPrivateAndSecrets(
      String(args.fact ?? args.question ?? args.header ?? '').trim()
    );
    if (!text) return null;
    return {
      taskId,
      workspace,
      type: 'decision',
      title: `Decision: ${text.slice(0, 90)}`,
      subtitle: normalizedTool,
      narrative: text.slice(0, 320),
      facts: [text.slice(0, 180)],
      concepts: ['decision', 'architecture'],
      filesRead: [],
      filesModified: [],
      toolName: normalizedTool,
      ...(params.nowMs !== undefined ? { createdAtEpochMs: params.nowMs } : {})
    };
  }

  return null;
}

export class EpisodicMemoryStore {
  private readonly storePath: string;
  private data: PersistedEpisodicData | null = null;
  private externalBridgeImported = false;
  private static defaultInstance: EpisodicMemoryStore | null = null;

  constructor(customStorePath?: string) {
    this.storePath = customStorePath
      ? path.resolve(customStorePath)
      : path.join(causyneHome(), 'episodic-memory.json');
  }

  static getInstance(): EpisodicMemoryStore {
    if (!EpisodicMemoryStore.defaultInstance) {
      EpisodicMemoryStore.defaultInstance = new EpisodicMemoryStore();
    }
    return EpisodicMemoryStore.defaultInstance;
  }

  private ensureLoaded(): PersistedEpisodicData {
    if (this.data) return this.data;
    try {
      if (fs.existsSync(this.storePath)) {
        const raw = JSON.parse(fs.readFileSync(this.storePath, 'utf8')) as Partial<PersistedEpisodicData>;
        if (raw && Array.isArray(raw.observations) && Array.isArray(raw.summaries)) {
          const cleanedObservations = raw.observations.filter((obs) => {
            if (obs.type !== 'discovery') return true;
            return !/^(?:Succeeded|Failed):\s*(?:find|wc|grep|egrep|fgrep|rg|sed|awk|jq|stat|file|ls|cat|head|tail|node\s+-e|python3?\s+-c)\b/i.test(obs.title);
          });
          this.data = {
            schemaVersion: 1,
            nextObservationId: typeof raw.nextObservationId === 'number' ? raw.nextObservationId : (raw.observations.length + 1),
            nextSummaryId: typeof raw.nextSummaryId === 'number' ? raw.nextSummaryId : (raw.summaries.length + 1),
            observations: cleanedObservations,
            summaries: raw.summaries
          };
          if (cleanedObservations.length !== raw.observations.length) {
            this.save();
          }
          return this.data;
        }
      }
    } catch {
      // Fallback to fresh store if corrupted
    }
    this.data = {
      schemaVersion: 1,
      nextObservationId: 1,
      nextSummaryId: 1,
      observations: [],
      summaries: []
    };
    return this.data;
  }

  private save(): void {
    if (!this.data) return;
    try {
      const dir = path.dirname(this.storePath);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      const tmpPath = `${this.storePath}.tmp.${process.pid}`;
      fs.writeFileSync(tmpPath, JSON.stringify(this.data, null, 2), { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmpPath, this.storePath);
    } catch {
      // Fail-open so memory persistence never crashes an active task
    }
  }

  /**
   * Record a new observation or reinforce an existing near-duplicate observation
   * using 2-Tier IDF-Veto deduplication.
   */
  recordObservation(input: RecordObservationInput): {
    observation: EpisodicObservation;
    dedupTier: 'exact' | 'candidate' | 'distinct';
    reinforcedId?: number | undefined;
  } {
    const store = this.ensureLoaded();
    const nowMs = input.createdAtEpochMs ?? Date.now();
    const project = projectFromWorkspace(input.workspace);

    const cleanTitle = redactPrivateAndSecrets(input.title).slice(0, 160);
    const cleanSubtitle = redactPrivateAndSecrets(input.subtitle ?? '').slice(0, 160);
    const cleanNarrative = redactPrivateAndSecrets(input.narrative).slice(0, 1200);
    const cleanFacts = (input.facts ?? []).map((f) => redactPrivateAndSecrets(f).slice(0, 200)).filter(Boolean);
    const cleanConcepts = (input.concepts ?? []).map((c) => redactPrivateAndSecrets(c).slice(0, 60)).filter(Boolean);
    const filesRead = [...new Set((input.filesRead ?? []).map((f) => String(f).trim()).filter(Boolean))].slice(0, 16);
    const filesModified = [...new Set((input.filesModified ?? []).map((f) => String(f).trim()).filter(Boolean))].slice(0, 16);

    const projectPool = store.observations.filter((o) => o.project === project);
    const idfMap = buildCorpusIdfMap(projectPool);

    // Check recent observations in the same project for Tier-0 or Tier-1 match
    for (let i = projectPool.length - 1; i >= Math.max(0, projectPool.length - 80); i--) {
      const existing = projectPool[i];
      if (!existing) continue;
      const decision = decideNearDuplicate(
        { title: cleanTitle, narrative: cleanNarrative },
        { title: existing.title, narrative: existing.narrative },
        idfMap,
        projectPool.length
      );
      if (decision.tier === 'exact' || decision.tier === 'candidate') {
        const nextReinforced = [...existing.reinforcedAtEpochsMs, nowMs].slice(-MAX_REINFORCEMENT_TIMESTAMPS);
        const updated: EpisodicObservation = {
          ...existing,
          reinforcedAtEpochsMs: nextReinforced,
          reinforcementCount: existing.reinforcementCount + 1,
          filesRead: [...new Set([...existing.filesRead, ...filesRead])].slice(0, 16),
          filesModified: [...new Set([...existing.filesModified, ...filesModified])].slice(0, 16),
          facts: [...new Set([...existing.facts, ...cleanFacts])].slice(0, 12)
        };
        const idx = store.observations.findIndex((o) => o.id === existing.id);
        if (idx >= 0) {
          store.observations[idx] = updated;
          this.save();
        }
        return {
          observation: updated,
          dedupTier: decision.tier,
          reinforcedId: updated.id
        };
      }
    }

    const created: EpisodicObservation = {
      id: store.nextObservationId++,
      taskId: input.taskId,
      workspace: input.workspace,
      project,
      type: input.type,
      title: cleanTitle,
      subtitle: cleanSubtitle,
      narrative: cleanNarrative,
      facts: cleanFacts,
      concepts: cleanConcepts,
      filesRead,
      filesModified,
      toolName: input.toolName,
      createdAtEpochMs: nowMs,
      reinforcedAtEpochsMs: [],
      reinforcementCount: 0,
      source: input.source ?? 'native'
    };

    store.observations.push(created);
    this.enforceProjectCap(project);
    this.save();

    return {
      observation: created,
      dedupTier: 'distinct'
    };
  }

  /**
   * Record a structured session checkpoint summary.
   */
  recordSessionSummary(input: {
    taskId: string;
    workspace: string;
    request: string;
    investigated?: string | undefined;
    learned?: string | undefined;
    completed: string;
    nextSteps?: string | undefined;
    createdAtEpochMs?: number | undefined;
  }): EpisodicSessionSummary {
    const store = this.ensureLoaded();
    const project = projectFromWorkspace(input.workspace);
    const summary: EpisodicSessionSummary = {
      id: store.nextSummaryId++,
      taskId: input.taskId,
      workspace: input.workspace,
      project,
      request: redactPrivateAndSecrets(input.request).slice(0, 300),
      investigated: redactPrivateAndSecrets(input.investigated ?? '').slice(0, 300),
      learned: redactPrivateAndSecrets(input.learned ?? '').slice(0, 300),
      completed: redactPrivateAndSecrets(input.completed).slice(0, 400),
      nextSteps: redactPrivateAndSecrets(input.nextSteps ?? '').slice(0, 240),
      createdAtEpochMs: input.createdAtEpochMs ?? Date.now()
    };
    store.summaries.push(summary);
    const projectSummaries = store.summaries.filter((s) => s.project === project);
    if (projectSummaries.length > MAX_SUMMARIES_PER_PROJECT) {
      const oldestId = projectSummaries[0]?.id;
      if (oldestId !== undefined) {
        store.summaries = store.summaries.filter((s) => s.id !== oldestId);
      }
    }
    this.save();
    return summary;
  }

  private enforceProjectCap(project: string): void {
    const store = this.ensureLoaded();
    const projectObs = store.observations.filter((o) => o.project === project);
    if (projectObs.length <= MAX_OBSERVATIONS_PER_PROJECT) return;

    // Retain top MAX_OBSERVATIONS_PER_PROJECT using ACT-R strength ranking so reinforced memories survive eviction
    const surviving = new Set(
      rankObservationsByStrength(projectObs, MAX_OBSERVATIONS_PER_PROJECT).map((o) => o.id)
    );
    store.observations = store.observations.filter(
      (o) => o.project !== project || surviving.has(o.id)
    );
  }

  /**
   * Layer 1 of Progressive Disclosure (`search`):
   * Returns a compact index of observations and session summaries matching `query`,
   * ranked by query term overlap + ACT-R cognitive strength.
   */
  searchIndex(options: SearchEpisodicOptions = {}): ProgressiveSearchResult {
    const store = this.ensureLoaded();
    const nowMs = options.nowMs ?? Date.now();
    const limit = Math.max(1, Math.min(50, options.limit ?? 15));
    const query = String(options.query ?? '').trim();
    const queryTokens = tokenizeForDedup(query);
    const targetProject = options.project
      ? options.project
      : options.workspace
        ? projectFromWorkspace(options.workspace)
        : '';

    const rows: ProgressiveSearchRow[] = [];

    for (const obs of store.observations) {
      if (options.workspaceOnly && targetProject && obs.project !== targetProject) continue;
      if (options.type && options.type !== 'summary' && obs.type !== options.type) continue;

      const haystack = `${obs.title} ${obs.subtitle} ${obs.narrative} ${obs.facts.join(' ')} ${obs.filesModified.join(' ')} ${obs.filesRead.join(' ')}`.toLowerCase();
      let termHits = 0;
      if (queryTokens.length > 0) {
        for (const qt of queryTokens) {
          if (haystack.includes(qt)) termHits += 1;
        }
        if (termHits === 0 && !haystack.includes(query.toLowerCase())) continue;
      }

      const actr = computeObservationStrength(obs.createdAtEpochMs, obs.reinforcedAtEpochsMs, nowMs);
      const projectBoost = targetProject && obs.project === targetProject ? 0.5 : 0;
      const score = termHits * 2.0 + actr + projectBoost;

      rows.push({
        id: `#${obs.id}`,
        numericId: obs.id,
        kind: 'observation',
        type: obs.type,
        project: obs.project,
        title: obs.title,
        subtitle: obs.subtitle || obs.toolName,
        createdAtEpochMs: obs.createdAtEpochMs,
        reinforcementCount: obs.reinforcementCount,
        score: Number(score.toFixed(4))
      });
    }

    if (!options.type || options.type === 'summary') {
      for (const sum of store.summaries) {
        if (options.workspaceOnly && targetProject && sum.project !== targetProject) continue;
        const haystack = `${sum.request} ${sum.learned} ${sum.completed} ${sum.nextSteps}`.toLowerCase();
        let termHits = 0;
        if (queryTokens.length > 0) {
          for (const qt of queryTokens) {
            if (haystack.includes(qt)) termHits += 1;
          }
          if (termHits === 0 && !haystack.includes(query.toLowerCase())) continue;
        }
        const actr = computeObservationStrength(sum.createdAtEpochMs, [], nowMs);
        const projectBoost = targetProject && sum.project === targetProject ? 0.5 : 0;
        const score = termHits * 2.0 + actr + projectBoost;

        rows.push({
          id: `S#${sum.id}`,
          numericId: sum.id,
          kind: 'summary',
          type: 'summary',
          project: sum.project,
          title: sum.request.slice(0, 120),
          subtitle: sum.completed.slice(0, 120),
          createdAtEpochMs: sum.createdAtEpochMs,
          reinforcementCount: 0,
          score: Number(score.toFixed(4))
        });
      }
    }

    rows.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.createdAtEpochMs - a.createdAtEpochMs;
    });

    return {
      query,
      totalMatches: rows.length,
      results: rows.slice(0, limit)
    };
  }

  /**
   * Layer 2 of Progressive Disclosure (`timeline`):
   * Returns a chronological window (`depthBefore`, `depthAfter`) around an anchor observation ID.
   */
  getTimelineWindow(options: TimelineQueryOptions): TimelineWindowResult {
    const store = this.ensureLoaded();
    const rawId = String(options.anchorId).replace(/^[#S]+/i, '').trim();
    const numericAnchor = Number.parseInt(rawId, 10);
    const depthBefore = Math.max(1, Math.min(20, options.depthBefore ?? 5));
    const depthAfter = Math.max(1, Math.min(20, options.depthAfter ?? 5));

    const targetObs = store.observations.find((o) => o.id === numericAnchor);
    if (!targetObs) {
      return {
        anchorId: `#${rawId}`,
        project: options.workspace ? projectFromWorkspace(options.workspace) : 'default',
        before: [],
        anchor: null,
        after: []
      };
    }

    const projectChronological = store.observations
      .filter((o) => o.project === targetObs.project)
      .sort((a, b) => a.createdAtEpochMs - b.createdAtEpochMs || a.id - b.id);

    const anchorIdx = projectChronological.findIndex((o) => o.id === targetObs.id);
    const toItem = (o: EpisodicObservation, isAnchor: boolean): TimelineWindowItem => ({
      id: `#${o.id}`,
      numericId: o.id,
      isAnchor,
      type: o.type,
      title: o.title,
      subtitle: o.subtitle,
      toolName: o.toolName,
      filesModified: o.filesModified,
      createdAtEpochMs: o.createdAtEpochMs
    });

    const beforeSlice = projectChronological.slice(Math.max(0, anchorIdx - depthBefore), anchorIdx);
    const afterSlice = projectChronological.slice(anchorIdx + 1, anchorIdx + 1 + depthAfter);

    return {
      anchorId: `#${targetObs.id}`,
      project: targetObs.project,
      before: beforeSlice.map((o) => toItem(o, false)),
      anchor: toItem(targetObs, true),
      after: afterSlice.map((o) => toItem(o, false))
    };
  }

  /**
   * Layer 3 of Progressive Disclosure (`get_observations`):
   * Fetches full observation details for specific IDs, bounded by `PROGRESSIVE_MAX_BYTES` (64 KB).
   * Also reinforces fetched observations via ACT-R since active retrieval indicates utility.
   */
  getObservationsByIds(
    ids: readonly (string | number)[],
    maxBytes: number = PROGRESSIVE_MAX_BYTES
  ): ObservationBatchResult {
    const store = this.ensureLoaded();
    const requestedIds = ids.map((id) => String(id).trim()).filter(Boolean);
    const observations: EpisodicObservation[] = [];
    const omittedIds: string[] = [];
    let totalBytes = 0;
    let truncatedByByteLimit = false;
    const nowMs = Date.now();
    let dirty = false;

    for (const raw of requestedIds) {
      const numId = Number.parseInt(raw.replace(/^[#S]+/i, ''), 10);
      if (!Number.isFinite(numId)) continue;
      const idx = store.observations.findIndex((o) => o.id === numId);
      if (idx < 0) continue;
      const obs = store.observations[idx];
      if (!obs) continue;

      const serialized = JSON.stringify(obs);
      const byteLen = Buffer.byteLength(serialized, 'utf8');
      if (observations.length > 0 && totalBytes + byteLen > maxBytes) {
        truncatedByByteLimit = true;
        omittedIds.push(`#${obs.id}`);
        continue;
      }

      totalBytes += byteLen;
      observations.push(obs);

      // Reinforce retrieved memory in ACT-R
      const reinforced = [...obs.reinforcedAtEpochsMs, nowMs].slice(-MAX_REINFORCEMENT_TIMESTAMPS);
      store.observations[idx] = {
        ...obs,
        reinforcedAtEpochsMs: reinforced,
        reinforcementCount: obs.reinforcementCount + 1
      };
      dirty = true;
    }

    if (dirty) {
      this.save();
    }

    return {
      requestedIds,
      observations,
      omittedIds,
      truncatedByByteLimit,
      totalBytes
    };
  }

  /**
   * Build the ACT-R ranked, character-budgeted startup context for `AgentLoop.buildStaticContext()`.
   */
  buildStartupEpisodicContext(
    workspace: string,
    maxChars: number = DEFAULT_EPISODIC_BUDGET_CHARS,
    nowMs: number = Date.now()
  ): string {
    this.autoSyncExternalBridgeOnce(workspace);
    const store = this.ensureLoaded();
    const project = projectFromWorkspace(workspace);
    const projectObservations = store.observations.filter((o) => o.project === project);
    const projectSummaries = store.summaries
      .filter((s) => s.project === project)
      .sort((a, b) => b.createdAtEpochMs - a.createdAtEpochMs)
      .slice(0, 5);

    if (projectObservations.length === 0 && projectSummaries.length === 0) {
      return '';
    }

    const ranked = rankObservationsByStrength(projectObservations, 16, nowMs);
    // Expand full narratives for top 3 highest-priority observations initially;
    // `fitEpisodicContextToBudget` will automatically shed them if over budget.
    const fullObservationIds = new Set<number>(ranked.slice(0, 3).map((o) => o.id));

    return fitEpisodicContextToBudget(
      {
        project,
        observations: ranked,
        summaries: projectSummaries,
        fullObservationIds,
        showLastSummaryDetails: true
      },
      maxChars
    );
  }

  /**
   * Auto-detect if a local SQLite episodic archive exists in `~/.causyne/memory-archive.db`
   * (or `CAUSYNE_MEMORY_ARCHIVE_DB`) and optionally import recent observations for the current project.
   */
  detectExternalMemoryStore(): { available: boolean; dbPath: string } {
    const envPath = process.env.CAUSYNE_MEMORY_ARCHIVE_DB?.trim();
    const candidate = envPath
      ? path.resolve(envPath)
      : path.join(causyneHome(), 'memory-archive.db');
    try {
      const stat = fs.statSync(candidate);
      return { available: stat.isFile() && stat.size > 0, dbPath: candidate };
    } catch {
      return { available: false, dbPath: candidate };
    }
  }

  autoSyncExternalBridgeOnce(workspace: string): number {
    if (this.externalBridgeImported) return 0;
    this.externalBridgeImported = true;
    const ext = this.detectExternalMemoryStore();
    if (!ext.available) return 0;

    const project = projectFromWorkspace(workspace);
    try {
      const sql = `SELECT title, subtitle, narrative, type, created_at_epoch FROM observations WHERE project = '${project.replace(/'/g, "''")}' ORDER BY created_at_epoch DESC LIMIT 20;`;
      const raw = execFileSync('sqlite3', ['-json', ext.dbPath, sql], {
        encoding: 'utf8',
        timeout: 1500,
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
      if (!raw) return 0;
      const rows = JSON.parse(raw) as Array<Record<string, unknown>>;
      let imported = 0;
      for (const row of rows) {
        const title = typeof row.title === 'string' ? row.title : '';
        const narrative = typeof row.narrative === 'string' ? row.narrative : '';
        if (!title) continue;
        const res = this.recordObservation({
          taskId: 'external_bridge',
          workspace,
          type: 'discovery',
          title,
          subtitle: typeof row.subtitle === 'string' ? row.subtitle : 'external',
          narrative,
          toolName: 'external_bridge',
          createdAtEpochMs: typeof row.created_at_epoch === 'number' ? row.created_at_epoch : Date.now(),
          source: 'external_bridge'
        });
        if (res.dedupTier === 'distinct') imported += 1;
      }
      return imported;
    } catch {
      return 0;
    }
  }

  getStats(workspace?: string): {
    totalObservations: number;
    totalSummaries: number;
    projectObservations: number;
    externalStoreAvailable: boolean;
    externalStorePath: string;
  } {
    const store = this.ensureLoaded();
    const project = workspace ? projectFromWorkspace(workspace) : '';
    const projectObservations = project
      ? store.observations.filter((o) => o.project === project).length
      : store.observations.length;
    const ext = this.detectExternalMemoryStore();
    return {
      totalObservations: store.observations.length,
      totalSummaries: store.summaries.length,
      projectObservations,
      externalStoreAvailable: ext.available,
      externalStorePath: ext.dbPath
    };
  }
}

export const episodicStore = EpisodicMemoryStore.getInstance();

