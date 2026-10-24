import { createHash } from 'node:crypto';
import { failureClass } from './planCache.js';
import { isVerificationCommand, type ToolOutcome } from './observer/evidence.js';

export const TIME_MACHINE_MAX_ATTEMPTS = 6;
export const TIME_MACHINE_REPLAN_AT = 3;

export interface RecoveryDecision {
  kind: 'continue' | 'replan' | 'stop' | 'human' | 'resolved' | 'none';
  attempt: number;
  maxAttempts: number;
  failureClass: string;
  lastGoodTool: string | null;
  guidance: string;
}

export function recoveryUserMessage(decision: RecoveryDecision, tool: string): string {
  if (decision.kind === 'human') {
    return `${tool} needs approval or authentication. Review the last tool error, then provide the needed access or choose another route. No success is claimed.`;
  }
  return `${tool} still failed after ${decision.attempt} attempts (${decision.failureClass}). The task stopped without verified success.`;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function operationFamily(args: Record<string, unknown>): string {
  const command = typeof args.command === 'string' ? args.command
    : typeof args.cmd === 'string' ? args.cmd : '';
  if (!command) return '';
  const words = command.trim().split(/\s+/).slice(0, 3);
  // Keep common verification commands distinct without retaining paths,
  // source text, environment variables, or credentials in the journal.
  if (/^(npm|pnpm|yarn|bun)$/.test(words[0] || '')) {
    return words.slice(0, words[1] === 'run' ? 3 : 2).join(' ').toLowerCase();
  }
  return (words[0] || '').replace(/^.*[\\/]/, '').toLowerCase().slice(0, 32);
}

function issueKey(tool: string, args: Record<string, unknown>, classification: string): string {
  const family = operationFamily(args);
  return createHash('sha256').update(`${tool}\0${family}\0${classification}`).digest('hex');
}

function lastGoodTool(outcomes: readonly ToolOutcome[]): string | null {
  for (let index = outcomes.length - 1; index >= 0; index--) {
    const outcome = outcomes[index];
    if (outcome?.success) return outcome.tool;
  }
  return null;
}

function nextDiagnostic(classification: string): string {
  switch (classification) {
    case 'not_found': return 'Check the actual path or command availability.';
    case 'syntax': return 'Inspect the parser location and the changed source.';
    case 'invalid_args': return 'Compare arguments with the tool schema.';
    case 'timeout': return 'Check whether the operation is still running before retrying.';
    case 'network': return 'Check connectivity or service status before another request.';
    case 'rate_limited': return 'Honor the provider retry window; do not send immediate repeats.';
    case 'exit_nonzero': return 'Inspect exit status and stderr; rerun the check after a change.';
    default: return 'Inspect the original tool output and the most recent change.';
  }
}

/** Per-task, deterministic recovery budget. Never replays actions or approvals. */
export class TimeMachine {
  private readonly failures = new Map<string, number>();

  reset(): void {
    this.failures.clear();
  }

  observe(tool: string, args: Record<string, unknown>, result: unknown,
    outcomes: readonly ToolOutcome[] = []): RecoveryDecision {
    const value = record(result);
    const failed = value.success === false || typeof value.error === 'string';
    const classification = failed ? failureClass(value) || 'failed' : '';
    const key = issueKey(tool, args, classification);
    const good = lastGoodTool(outcomes);

    if (!failed) {
      // A successful check only clears its own failure family. A successful
      // read/write cannot prove that a failing build or test was repaired.
      const possibleKeys = ['failed', 'exit_nonzero', 'syntax', 'invalid_args',
        'not_found', 'timeout', 'network', 'rate_limited', 'permission'];
      const hadFailure = possibleKeys.some((item) => this.failures.has(issueKey(tool, args, item)));
      if (hadFailure) {
        for (const item of possibleKeys) this.failures.delete(issueKey(tool, args, item));
      }
      return {
        kind: hadFailure ? 'resolved' : 'none', attempt: 0,
        maxAttempts: TIME_MACHINE_MAX_ATTEMPTS, failureClass: '',
        lastGoodTool: good,
        guidance: hadFailure
          ? isVerificationCommand(String(args.command || args.cmd || ''))
            ? 'The same verification command now passed. Report that check as evidence; assess the rest of the task separately.'
            : 'This tool call succeeded. Verify the intended task outcome before reporting success.'
          : ''
      };
    }

    const error = typeof value.error === 'string' ? value.error : '';
    const needsHuman = classification === 'permission' || /user denied|approval required|authentication required/i.test(error);
    const attempt = (this.failures.get(key) || 0) + 1;
    this.failures.set(key, attempt);
    const checkpoint = good ? ` Last successful tool: ${good}.` : '';

    if (needsHuman) {
      return { kind: 'human', attempt, maxAttempts: TIME_MACHINE_MAX_ATTEMPTS,
        failureClass: classification, lastGoodTool: good,
        guidance: `Permission or authentication is required. Stop retrying and explain the exact user action needed.${checkpoint}` };
    }
    if (attempt >= TIME_MACHINE_MAX_ATTEMPTS) {
      return { kind: 'stop', attempt, maxAttempts: TIME_MACHINE_MAX_ATTEMPTS,
        failureClass: classification, lastGoodTool: good,
        guidance: `The same failure class persisted through ${TIME_MACHINE_MAX_ATTEMPTS} attempts. Stop this task. Give a brief evidence-based report, state what remains unresolved, and ask for input only if needed. Put a detailed report in a Markdown file only if the user requests one.${checkpoint}` };
    }
    if (attempt >= TIME_MACHINE_REPLAN_AT) {
      return { kind: 'replan', attempt, maxAttempts: TIME_MACHINE_MAX_ATTEMPTS,
        failureClass: classification, lastGoodTool: good,
        guidance: `Review the last successful step and the failing evidence. ${nextDiagnostic(classification)} Change approach before another attempt; do not repeat the same command or claim a fix without a passing check.${checkpoint}` };
    }
    return { kind: 'continue', attempt, maxAttempts: TIME_MACHINE_MAX_ATTEMPTS,
      failureClass: classification, lastGoodTool: good,
      guidance: `Inspect this failure before retrying. Attempt ${attempt}/${TIME_MACHINE_MAX_ATTEMPTS}.${checkpoint}` };
  }
}
