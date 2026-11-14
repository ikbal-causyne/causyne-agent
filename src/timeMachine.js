import { createHash } from 'node:crypto';
import { failureClass } from './planCache.js';
import { isVerificationCommand } from './observer/evidence.js';
export const TIME_MACHINE_MAX_ATTEMPTS = 6;
/**
 * After this many failed attempts at the same issue the agent must stop and ask
 * the user before trying again. Attempts beyond it are three more rounds of
 * similar edits and checks, which cost real time and tokens, so they are the
 * user's call and never the agent's.
 */
export const TIME_MACHINE_CONSENT_AT = 3;
export function recoveryUserMessage(decision, tool) {
    if (decision.kind === 'human') {
        return `${tool} needs approval or authentication. Review the last tool error, then provide the needed access or choose another route. No success is claimed.`;
    }
    // A stop before the hard maximum only happens when further attempts were not approved.
    if (decision.attempt < TIME_MACHINE_MAX_ATTEMPTS && decision.kind === 'stop') {
        return `${tool} failed ${decision.attempt} times (${decision.failureClass}) and more attempts were not approved. The task stopped without verified success.`;
    }
    return `${tool} still failed after ${decision.attempt} attempts (${decision.failureClass}). The task stopped without verified success.`;
}
function record(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value : {};
}
function commandText(args) {
    return [args.command, args.cmd, args.CommandLine, args.commandLine, args.script]
        .find((value) => typeof value === 'string' && value.trim().length > 0) ?? '';
}
function operationFamily(args) {
    const command = commandText(args);
    if (!command) {
        const endpoint = typeof args.url === 'string' ? args.url : typeof args.endpoint === 'string' ? args.endpoint : '';
        if (endpoint) {
            try {
                return new URL(endpoint).hostname.toLowerCase();
            }
            catch {
                return '';
            }
        }
        return '';
    }
    const tokens = command.trim().split(/\s+/);
    // Leading VAR=value assignments do not change which operation is retried, so
    // `CI=1 npm test` must share the retry budget of `npm test`.
    while (tokens.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0] || ''))
        tokens.shift();
    const words = tokens.slice(0, 3);
    // Windows shims (`npm.cmd`, `bun.exe`) are the same tools as their bare names.
    const executable = (words[0] || '').replace(/^.*[\\/]/, '').replace(/\.(cmd|exe|bat|ps1)$/i, '').toLowerCase();
    // Keep common verification commands distinct without retaining paths,
    // source text, environment variables, or credentials in the journal.
    if (/^(npm|pnpm|yarn|bun)$/.test(executable)) {
        // Script names are case-sensitive; a passing `build` cannot resolve `Build`.
        return [executable, ...words.slice(1, words[1] === 'run' ? 3 : 2)].join(' ');
    }
    return executable.slice(0, 32);
}
function issueKey(tool, args) {
    const family = operationFamily(args);
    const target = String(args.path ?? args.file_path ?? args.filePath ?? args.target ?? args.endpoint ?? args.url ?? '');
    const workspace = String(args.cwd ?? '');
    // Changing error text/class does not buy another three attempts at the same
    // operation. Targets are hashed and never included in recovery messages.
    return createHash('sha256').update(`${tool}\0${family}\0${target}\0${workspace}`).digest('hex');
}
function lastGoodTool(outcomes) {
    for (let index = outcomes.length - 1; index >= 0; index--) {
        const outcome = outcomes[index];
        if (outcome?.success && (outcome.exitCode == null || outcome.exitCode === 0) && !outcome.error?.trim())
            return outcome.tool;
    }
    return null;
}
function nextDiagnostic(classification) {
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
    failures = new Map();
    extended = new Set();
    reset() {
        this.failures.clear();
        this.extended.clear();
    }
    /** The user approved attempts beyond the consent point for this issue, up to the hard maximum. */
    grantExtension(issueKeyValue) {
        const count = this.failures.get(issueKeyValue) ?? 0;
        if (count >= TIME_MACHINE_CONSENT_AT && count < TIME_MACHINE_MAX_ATTEMPTS)
            this.extended.add(issueKeyValue);
    }
    /** Whether the user already approved further attempts for this issue. */
    isExtended(issueKeyValue) {
        return this.extended.has(issueKeyValue);
    }
    observe(tool, args, result, outcomes = []) {
        const value = record(result);
        const failed = value.success === false || (typeof value.error === 'string' && value.error.trim().length > 0)
            || (typeof value.exitCode === 'number' && (!Number.isFinite(value.exitCode) || value.exitCode !== 0))
            || value.failureKind === 'site_refusal';
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
                    ? isVerificationCommand(commandText(args))
                        ? 'The same verification command now passed. Report that check as evidence; assess the rest of the task separately.'
                        : 'This tool call succeeded. Verify the intended task outcome before reporting success.'
                    : ''
            };
        }
        const error = typeof value.error === 'string' ? value.error : '';
        const needsHuman = classification === 'permission' || /user denied|approval required|authentication required/i.test(error);
        const attempt = Math.min(TIME_MACHINE_MAX_ATTEMPTS, (this.failures.get(key) || 0) + 1);
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
                guidance: `The same operation failed through ${TIME_MACHINE_MAX_ATTEMPTS} attempts. Stop this task. Give a brief evidence-based report, state what remains unresolved, and ask for input only if needed. Put a detailed report in a Markdown file only if the user requests one.${checkpoint}` };
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
        if (classification === 'rate_limited' && attempt < TIME_MACHINE_CONSENT_AT) {
            return { kind: 'replan', attempt, maxAttempts: TIME_MACHINE_MAX_ATTEMPTS, issueKey: key,
                failureClass: classification, lastGoodTool: good,
                guidance: `Rate limit reached. Respect the provider's retry/reset window; do not immediately resend the same request.${checkpoint}` };
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
