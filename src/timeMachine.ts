import { createHash } from 'node:crypto';
import { failureClass } from './planCache.js';
import { isVerificationCommand, type ToolOutcome } from './observer/evidence.js';

export const TIME_MACHINE_MAX_ATTEMPTS = 6;
/**
 * After this many failed attempts at the same issue the agent must stop and ask
 * the user before trying again. Attempts beyond it are three more rounds of
 * similar edits and checks, which cost real time and tokens, so they are the
 * user's call and never the agent's.
 */
export const TIME_MACHINE_CONSENT_AT = 3;

export interface RecoveryDecision {
  /**
   * `consent` means the attempt budget the agent may spend alone is used up:
   * the caller must ask the user and call `grantExtension` only on approval.
   */
  kind: 'continue' | 'replan' | 'consent' | 'stop' | 'human' | 'resolved' | 'none';
  attempt: number;
  maxAttempts: number;
  failureClass: string;
  lastGoodTool: string | null;
  guidance: string;
  /** Opaque identifier of the failing issue, for `grantExtension`. Empty when nothing failed. */
  issueKey: string;
}

export function recoveryUserMessage(decision: RecoveryDecision, tool: string): string {
  if (decision.kind === 'human') {
    return `${tool} needs approval or authentication. Review the last tool error, then provide the needed access or choose another route. No success is claimed.`;
  }
  if (decision.attempt <= TIME_MACHINE_CONSENT_AT && decision.kind === 'stop') {
    return `${tool} failed ${decision.attempt} times (${decision.failureClass}) and more attempts were not approved. The task stopped without verified success.`;
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
  if (!command) {
    if (typeof args.url === 'string') {
      try { return new URL(args.url).hostname.toLowerCase(); } catch { return ''; }
    }
    return '';
  }
  const words = command.trim().split(/\s+/).slice(0, 3);
  // Keep common verification commands distinct without retaining paths,
  // source text, environment variables, or credentials in the journal.
  if (/^(npm|pnpm|yarn|bun)$/.test(words[0] || '')) {
    return words.slice(0, words[1] === 'run' ? 3 : 2).join(' ').toLowerCase();
  }
  return (words[0] || '').replace(/^.*[\\/]/, '').toLowerCase().slice(0, 32);
}

function issueKey(tool: string, args: Record<string, unknown>): string {
  const family = operationFamily(args);
  const target = String(args.path ?? args.file_path ?? args.filePath ?? '');
  // Changing error text/class does not buy another three attempts at the same
  // operation. Targets are hashed and never included in recovery messages.
  return createHash('sha256').update(`${tool}\0${family}\0${target}`).digest('hex');
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
  private readonly extended = new Set<string>();

  reset(): void {
    this.failures.clear();
    this.extended.clear();
  }

  /** The user approved attempts beyond the consent point for this issue, up to the hard maximum. */
  grantExtension(issueKeyValue: string): void {
    const count = this.failures.get(issueKeyValue) ?? 0;
    if (count >= TIME_MACHINE_CONSENT_AT && count < TIME_MACHINE_MAX_ATTEMPTS) this.extended.add(issueKeyValue);
  }

  /** Whether the user already approved further attempts for this issue. */
  isExtended(issueKeyValue: string): boolean {
    return this.extended.has(issueKeyValue);
  }

  observe(tool: string, args: Record<string, unknown>, result: unknown,
    outcomes: readonly ToolOutcome[] = []): RecoveryDecision {
    const value = record(result);
    const failed = value.success === false || typeof value.error === 'string';
    const classification = failed ? failureClass(value) || 'failed' : '';
    const key = issueKey(tool, args);
    const good = lastGoodTool(outcomes);

    if (!failed) {
      // A successful check only clears its own failure family. A successful
      // read/write cannot prove that a failing build or test was repaired.
      const hadFailure = this.failures.has(key);
      if (hadFailure) {
        this.failures.delete(key);
        this.extended.delete(key);
      }
      return {
        kind: hadFailure ? 'resolved' : 'none', attempt: 0,
        maxAttempts: TIME_MACHINE_MAX_ATTEMPTS, failureClass: '',
        issueKey: '',
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
      return { kind: 'human', attempt, maxAttempts: TIME_MACHINE_MAX_ATTEMPTS, issueKey: key,
        failureClass: classification, lastGoodTool: good,
        guidance: `Permission or authentication is required. Stop retrying and explain the exact user action needed.${checkpoint}` };
    }
    if (attempt >= TIME_MACHINE_MAX_ATTEMPTS) {
      return { kind: 'stop', attempt, maxAttempts: TIME_MACHINE_MAX_ATTEMPTS, issueKey: key,
        failureClass: classification, lastGoodTool: good,
        guidance: `The same failure class persisted through ${TIME_MACHINE_MAX_ATTEMPTS} attempts. Stop this task. Give a brief evidence-based report, state what remains unresolved, and ask for input only if needed. Put a detailed report in a Markdown file only if the user requests one.${checkpoint}` };
    }
    // The agent may spend three attempts alone. The fourth through sixth belong
    // to the user: without an explicit grant the budget ends here.
    if (attempt >= TIME_MACHINE_CONSENT_AT && !this.extended.has(key)) {
      if (attempt === TIME_MACHINE_CONSENT_AT) {
        return { kind: 'consent', attempt, maxAttempts: TIME_MACHINE_MAX_ATTEMPTS, issueKey: key,
          failureClass: classification, lastGoodTool: good,
          guidance: `Three attempts failed. Ask the user before trying again. If they allow it, change approach completely: review the last successful step and the failing evidence. ${nextDiagnostic(classification)}${checkpoint}` };
      }
      return { kind: 'stop', attempt, maxAttempts: TIME_MACHINE_MAX_ATTEMPTS, issueKey: key,
        failureClass: classification, lastGoodTool: good,
        guidance: `Further attempts were not approved. Stop this task. Give a brief evidence-based report and state what remains unresolved.${checkpoint}` };
    }
    if (value.failureKind === 'site_refusal' && attempt < TIME_MACHINE_MAX_ATTEMPTS) {
      return { kind: 'replan', attempt, maxAttempts: TIME_MACHINE_MAX_ATTEMPTS, issueKey: key,
        failureClass: classification, lastGoodTool: good,
        guidance: `The site refused this fetch. Do not repeat the same URL or bypass the site's restriction. Search for another public source or use an already available browser capability.${checkpoint}` };
    }

    if (attempt >= TIME_MACHINE_CONSENT_AT) {
      return { kind: 'replan', attempt, maxAttempts: TIME_MACHINE_MAX_ATTEMPTS, issueKey: key,
        failureClass: classification, lastGoodTool: good,
        guidance: `Review the last successful step and the failing evidence. ${nextDiagnostic(classification)} Change approach before another attempt; do not repeat the same command or claim a fix without a passing check. ${TIME_MACHINE_MAX_ATTEMPTS - attempt} attempt(s) remain.${checkpoint}` };
    }
    return { kind: 'continue', attempt, maxAttempts: TIME_MACHINE_MAX_ATTEMPTS, issueKey: key,
      failureClass: classification, lastGoodTool: good,
      guidance: `Inspect this failure before retrying. Attempt ${attempt}/${TIME_MACHINE_MAX_ATTEMPTS}.${checkpoint}` };
  }
}
