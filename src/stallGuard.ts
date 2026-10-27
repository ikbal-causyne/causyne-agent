import { createHash } from 'node:crypto';
import { isMutatingToolCall } from './decisionPolicy.js';

export interface ToolCallSignature {
  toolName: string;
  argsHash: string;
}

export interface StallGuardDecision {
  action: 'allow' | 'warn' | 'block' | 'halt';
  code: string;
  message: string;
  toolName: string;
  count: number;
  signature?: ToolCallSignature;
  period?: number;
}

export interface IdenticalCallObservation {
  notice: string | null;
  stub: string | null;
  decision?: StallGuardDecision | null;
}

export interface StallGuardConfig {
  warningsEnabled?: boolean;
  hardStopEnabled?: boolean;
  identicalCallWarnAfter?: number;
  identicalCallHaltAfter?: number;
  cycleWarnAfter?: number;
  cycleHaltAfter?: number;
  researchNudgeAfter?: number;
  stubMinChars?: number;
}

export const STALL_GUARD_REPEATABLE_TOOLS = new Set([
  'process_list',
  'sys_run_poll',
  'proc_term'
]);

export const FAILURE_TOLERANT_TOOL_NAMES = new Set([
  'sysRun',
  'sysRunBg',
  'terminal_persistent_shell',
  'grep_search',
  'fs_search',
  'code_searcher',
  'codebase_search',
  'web_search'
]);

export const IDEMPOTENT_TOOL_NAMES = new Set([
  'fs_read',
  'fs_list',
  'fs_find',
  'fs_search',
  'code_search_ast',
  'code_searcher',
  'codebase_search',
  'pdf_read',
  'clipboard_read',
  'read_native_skill',
  'desktop_open',
  'check_system_specs',
  'web_search',
  'web_fetch',
  'grep_search',
  'dir_list',
  'view_image',
  'vision_inspect_ui',
  'ax_snapshot',
  'browser_snapshot',
  'browser_console',
  'browser_get_dom',
  'read_browser_page',
  'deferred_mcp_search'
]);

export const MUTATING_TOOL_NAMES = new Set([
  'fs_write',
  'fs_edit',
  'MultiEdit',
  'fs_delete',
  'fs_move',
  'archive_extract',
  'game_build_html5',
  'tool_forge',
  'create_skill',
  'manage_local_dependencies',
  'creative_batch',
  'blender_act',
  'godot_act'
]);

export const STALL_GUARD_IDENTICAL_CALL_THRESHOLD = 3;
export const STALL_GUARD_IDENTICAL_CALL_HALT = 5;
export const STALL_GUARD_MAX_CYCLE_PERIOD = 4;
export const STALL_GUARD_CYCLE_HISTORY = 64;
export const IDENTICAL_RESULT_STUB_MIN_CHARS = 512;
export const RESEARCH_INSPECTION_NUDGE_AFTER = 25;

function stableSortObject(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(stableSortObject);
  }
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = stableSortObject((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

export function canonicalToolArgs(args: unknown): string {
  if (!args || typeof args !== 'object') {
    return JSON.stringify(args ?? {});
  }
  return JSON.stringify(stableSortObject(args));
}

export function buildToolCallSignature(toolName: string, args: unknown): ToolCallSignature {
  const canonical = canonicalToolArgs(args);
  const argsHash = createHash('sha256').update(canonical).digest('hex').slice(0, 16);
  return { toolName, argsHash };
}

export function computeResultHash(result: unknown): string {
  if (result === null || result === undefined) return '';
  const str = typeof result === 'string' ? result : JSON.stringify(result);
  return createHash('sha256').update(str).digest('hex').slice(0, 24);
}

function ordinal(n: number): string {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

export class StallGuardController {
  private config: Required<StallGuardConfig>;
  private _identicalStreakSig: ToolCallSignature | null = null;
  private _identicalStreakResultHash = '';
  private _identicalStreakCount = 0;
  private _identicalStreakFirstCallId = '';
  private _callHistory: Array<{ sig: ToolCallSignature; resultHash: string; repeatable: boolean }> = [];
  private _exactFailureCounts = new Map<string, number>();
  private _distinctInspectionCount = 0;
  private _researchNudgeEmitted = false;
  private _haltDecision: StallGuardDecision | null = null;

  constructor(config?: StallGuardConfig) {
    this.config = {
      warningsEnabled: config?.warningsEnabled ?? true,
      hardStopEnabled: config?.hardStopEnabled ?? false,
      identicalCallWarnAfter: config?.identicalCallWarnAfter ?? STALL_GUARD_IDENTICAL_CALL_THRESHOLD,
      identicalCallHaltAfter: config?.identicalCallHaltAfter ?? STALL_GUARD_IDENTICAL_CALL_HALT,
      cycleWarnAfter: config?.cycleWarnAfter ?? STALL_GUARD_IDENTICAL_CALL_THRESHOLD,
      cycleHaltAfter: config?.cycleHaltAfter ?? STALL_GUARD_IDENTICAL_CALL_HALT,
      researchNudgeAfter: config?.researchNudgeAfter ?? RESEARCH_INSPECTION_NUDGE_AFTER,
      stubMinChars: config?.stubMinChars ?? IDENTICAL_RESULT_STUB_MIN_CHARS
    };
  }

  get haltDecision(): StallGuardDecision | null {
    return this._haltDecision;
  }

  get distinctInspectionCount(): number {
    return this._distinctInspectionCount;
  }

  reset(): void {
    this._identicalStreakSig = null;
    this._identicalStreakResultHash = '';
    this._identicalStreakCount = 0;
    this._identicalStreakFirstCallId = '';
    this._callHistory = [];
    this._exactFailureCounts.clear();
    this._distinctInspectionCount = 0;
    this._researchNudgeEmitted = false;
    this._haltDecision = null;
  }

  isRepeatable(toolName: string, args: Record<string, unknown> = {}): boolean {
    if (STALL_GUARD_REPEATABLE_TOOLS.has(toolName)) return true;
    if (toolName.endsWith('_poll') || toolName.endsWith('_status') || toolName.endsWith('_get_result')) return true;
    if (toolName === 'sysRun' || toolName === 'sysRunBg') {
      const cmd = String(args.command ?? '').trim();
      if (/^(?:ps\s+aux|pgrep|lsof|netstat|ss\s+-)\b/i.test(cmd)) return true;
    }
    return false;
  }

  isMutating(toolName: string, args: Record<string, unknown> = {}): boolean {
    if (MUTATING_TOOL_NAMES.has(toolName)) return true;
    return isMutatingToolCall(toolName, args);
  }

  isFailureTolerant(toolName: string): boolean {
    return FAILURE_TOLERANT_TOOL_NAMES.has(toolName);
  }

  recordMutation(): void {
    this._exactFailureCounts.clear();
    this._distinctInspectionCount = 0;
    this._researchNudgeEmitted = false;
  }

  beforeCall(
    toolName: string,
    args: Record<string, unknown> = {},
    context?: { isAuthoringTask?: boolean }
  ): StallGuardDecision {
    const signature = buildToolCallSignature(toolName, args);
    const sigKey = `${signature.toolName}:${signature.argsHash}`;

    if (this._haltDecision) {
      return this._haltDecision;
    }

    const failureCount = this._exactFailureCounts.get(sigKey) || 0;
    if (this.config.hardStopEnabled && failureCount >= this.config.identicalCallHaltAfter) {
      const decision: StallGuardDecision = {
        action: 'halt',
        code: 'repeated_exact_failure_halt',
        message: `Halted: identical call to '${toolName}' failed ${failureCount} times with unchanged arguments. Change strategy or explain the blocker.`,
        toolName,
        count: failureCount,
        signature
      };
      this._haltDecision = decision;
      return decision;
    }

    const repeatable = this.isRepeatable(toolName, args);
    if (!repeatable && this._identicalStreakSig !== null) {
      const isStreakMatch = this._identicalStreakSig.toolName === signature.toolName
        && this._identicalStreakSig.argsHash === signature.argsHash;

      if (isStreakMatch && this.config.hardStopEnabled && this._identicalStreakCount >= this.config.identicalCallHaltAfter) {
        const decision: StallGuardDecision = {
          action: 'halt',
          code: 'identical_call_limit_halt',
          message: `Halted: tool '${toolName}' was invoked identically ${this._identicalStreakCount} times without progress.`,
          toolName,
          count: this._identicalStreakCount,
          signature
        };
        this._haltDecision = decision;
        return decision;
      }
    }

    if (context?.isAuthoringTask && !this.isMutating(toolName, args) && this._distinctInspectionCount >= 24) {
      const decision: StallGuardDecision = {
        action: 'halt',
        code: 'read_only_loop_halt',
        message: `FATAL ERROR: Read-Only Verification Loop Detected. Agent performed ${this._distinctInspectionCount} consecutive inspection steps without writing any implementation code. Forcibly aborting task to save tokens.`,
        toolName,
        count: this._distinctInspectionCount,
        signature
      };
      this._haltDecision = decision;
      return decision;
    }

    return {
      action: 'allow',
      code: 'allow',
      message: '',
      toolName,
      count: 0,
      signature
    };
  }

  observeCall(
    toolName: string,
    args: Record<string, unknown> = {},
    result: unknown,
    toolCallId = '',
    failed = false
  ): IdenticalCallObservation {
    const signature = buildToolCallSignature(toolName, args);
    const sigKey = `${signature.toolName}:${signature.argsHash}`;
    const resultStr = typeof result === 'string' ? result : JSON.stringify(result ?? {});
    const rHash = computeResultHash(resultStr);
    const repeatable = this.isRepeatable(toolName, args);
    const mutating = this.isMutating(toolName, args);

    if (mutating && !failed) {
      this.recordMutation();
    } else if (!mutating) {
      this._distinctInspectionCount++;
    }

    if (failed) {
      const count = (this._exactFailureCounts.get(sigKey) || 0) + 1;
      this._exactFailureCounts.set(sigKey, count);
      this._identicalStreakSig = null;
      this._identicalStreakResultHash = '';
      this._identicalStreakCount = 0;

      let notice: string | null = null;
      if (this.config.warningsEnabled && count >= this.config.identicalCallWarnAfter) {
        notice = `[STALL GUARD: Tool '${toolName}' with identical arguments failed ${count} times. Stop retrying unchanged; change arguments or adopt an alternative approach.]`;
      }
      return { notice, stub: null };
    }

    const matchesStreak = this._identicalStreakSig !== null
      && this._identicalStreakSig.toolName === signature.toolName
      && this._identicalStreakSig.argsHash === signature.argsHash
      && this._identicalStreakResultHash === rHash;

    if (matchesStreak) {
      this._identicalStreakCount++;
    } else {
      this._identicalStreakSig = signature;
      this._identicalStreakResultHash = rHash;
      this._identicalStreakCount = 1;
      this._identicalStreakFirstCallId = toolCallId || '';
    }

    const count = this._identicalStreakCount;
    let stub: string | null = null;
    let notice: string | null = null;
    let decision: StallGuardDecision | null = null;

    if (count >= 2 && !failed && resultStr.length >= this.config.stubMinChars) {
      const argsPreview = canonicalToolArgs(args).slice(0, 100);
      const priorId = this._identicalStreakFirstCallId ? `prior call ${this._identicalStreakFirstCallId}` : 'previous call';
      stub = JSON.stringify({
        success: true,
        unchanged: true,
        stub: `[Duplicate result identical to ${priorId}: ${toolName}(${argsPreview})]`
      });
    }

    if (!repeatable && count >= this.config.identicalCallWarnAfter) {
      notice = `[STALL GUARD: This is the ${ordinal(count)} consecutive identical call to '${toolName}' with identical arguments returning the unchanged result. Do not repeat it — change arguments, use a different tool, or proceed with what you have.]`;

      if (this.config.hardStopEnabled && count >= this.config.identicalCallHaltAfter && !this._haltDecision) {
        decision = {
          action: 'halt',
          code: 'identical_call_streak_halt',
          message: `Stopped ${toolName}: the same call with identical arguments returned the same result ${count} times in a row. Stop repeating it unchanged; use the result already provided or change strategy.`,
          toolName,
          count,
          signature
        };
        this._haltDecision = decision;
      }
    }

    this._callHistory.push({ sig: signature, resultHash: rHash, repeatable });
    if (this._callHistory.length > STALL_GUARD_CYCLE_HISTORY) {
      this._callHistory.shift();
    }

    if (!notice) {
      const cycle = this.detectIdenticalCycle();
      if (cycle) {
        const { period, laps } = cycle;
        notice = `[STALL GUARD: The last ${laps} rounds repeated the same cycle of ${period} tool calls (ending with '${toolName}') with identical arguments and identical results. Do not repeat the batch — change arguments, synthesize findings, or proceed.]`;

        if (this.config.hardStopEnabled && laps >= this.config.cycleHaltAfter && !this._haltDecision) {
          decision = {
            action: 'halt',
            code: 'identical_cycle_halt',
            message: `Stopped ${toolName}: repeating cycle of ${period} tool calls with identical arguments and results has run ${laps} times. Repeating the batch unchanged is not progress; use the results already provided or change strategy.`,
            toolName,
            count: laps,
            period,
            signature
          };
          this._haltDecision = decision;
        }
      }
    }

    if (!notice && !this._researchNudgeEmitted && this._distinctInspectionCount >= this.config.researchNudgeAfter) {
      this._researchNudgeEmitted = true;
      notice = `[RESEARCH PROGRESS NOTICE: You have performed ${this._distinctInspectionCount} consecutive inspection steps across the workspace. If sufficient context has been gathered, consider proceeding to implementation or updating the plan.]`;
    }

    return { notice, stub, decision };
  }

  detectIdenticalCycle(): { period: number; laps: number } | null {
    const history = this._callHistory;
    for (let period = 2; period <= STALL_GUARD_MAX_CYCLE_PERIOD; period++) {
      if (history.length < period * this.config.cycleWarnAfter) {
        continue;
      }
      let laps = 1;
      while (true) {
        const base = history.length - period * (laps + 1);
        if (base < 0) break;

        let lapEqual = true;
        for (let i = 0; i < period; i++) {
          const past = history[base + i];
          const curr = history[history.length - period + i];
          if (!past || !curr || past.sig.toolName !== curr.sig.toolName || past.sig.argsHash !== curr.sig.argsHash || past.resultHash !== curr.resultHash) {
            lapEqual = false;
            break;
          }
        }
        if (!lapEqual) break;
        laps++;
      }

      if (laps >= this.config.cycleWarnAfter) {
        const tail = history.slice(history.length - period);
        if (tail.every(item => item.repeatable)) {
          continue;
        }
        return { period, laps };
      }
    }
    return null;
  }
}
