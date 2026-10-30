import fs from 'node:fs';
import path from 'node:path';
import { auditLog } from '../auditLog.js';
import { causyneHome } from '../utils/paths.js';
import { boundedArgs, outcomeFromResult, scanMutation } from './evidence.js';
import { isLoopbackEndpoint, probeAdvisory, queryAdvisory } from './advisory.js';
const CONFIG_FILE = path.join(causyneHome(), 'observer.json');
const MAX_AUDIT_RECORDS = 200;
const MAX_JOURNAL_TASKS = 24;
const MAX_JOURNAL_OUTCOMES = 160;
const ADVISORY_FAILURE_LIMIT = 3;
const ADVISORY_COOLDOWN_MS = 5 * 60 * 1000;
const DEFAULT_CONFIG = {
    enabled: true,
    mode: 'deterministic',
    endpoint: '',
    model: '',
    timeoutMs: 800,
    strictness: 'standard'
};
const COMPLETION_CLAIMS = [
    /\b(?:done|finished|complete(?:d)?|implemented|resolved|fixed|ready)\b/i,
    /\b(?:all|everything)\b[^.\n]{0,60}\b(?:works?|pass(?:es|ed|ing)?|fixed|done|clean)\b/i,
    /\b(?:no|zero)\s+(?:errors?|issues?|failures?|bugs?)\b/i
];
const HONEST_CAVEATS = [
    /\b(?:not|never)\s+(?:run|ran|tested|verified|checked|completed?)\b/i,
    /\b(?:have not|haven't|did not|didn't|could not|couldn't|unable to)\b[^.\n]{0,60}\b(?:run|test|verify|finish|complete|fix|resolve)\b/i,
    /\b(?:still|remains?)\s+(?:failing|broken|unresolved|incomplete|open)\b/i,
    /\b(?:partially|incompletely)\s+(?:done|fixed|implemented|verified)\b/i
];
const TEST_COMMAND = /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test|node\s+--test|pytest|cargo\s+test|go\s+test|mvn\s+test|gradle\s+test|dotnet\s+test|swift\s+test)\b/i;
const BUILD_OR_CHECK_COMMAND = /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:build|check|lint|typecheck|types)|node\s+(?:--check|-c)|py_compile|compileall|tsc(?:\s|$)|eslint|biome\s+(?:check|ci)|cargo\s+check|go\s+vet|ruby\s+-c|php\s+-l)\b/i;
const TESTS_CLAIM = /\b(?:all\s+)?tests?\b[^.\n]{0,40}\b(?:pass|passed|passing|green|succeed|succeeded)\b/i;
const BUILD_CLAIM = /\b(?:build|typecheck|types|lint|compilation)\b[^.\n]{0,40}\b(?:pass|passed|passing|clean|succeed|succeeded)\b/i;
const MUTATING_TOOLS = new Set([
    'fs_write', 'fs_edit', 'MultiEdit', 'fs_delete', 'fs_move',
    'sysRun', 'sysRunBg', 'terminal_persistent_shell', 'gitOp',
    'write_file', 'write_to_file', 'edit_file', 'replace_file_content',
    'multi_replace_file_content', 'write', 'edit', 'multiedit', 'bash', 'execute'
]);
function normalizeMode(value) {
    if (value === 'deterministic')
        return 'deterministic';
    if (value === 'advisory' || value === 'local' || value === 'hybrid')
        return 'advisory';
    return null;
}
function normalizeStrictness(value) {
    if (value === 'relaxed' || value === 'moderate')
        return 'relaxed';
    if (value === 'standard')
        return 'standard';
    if (value === 'strict' || value === 'paranoid')
        return 'strict';
    return null;
}
function boundedTimeout(value) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return null;
    return Math.max(200, Math.min(5000, Math.round(value)));
}
function safeConfigPath() {
    return CONFIG_FILE;
}
function readStoredConfig() {
    try {
        const raw = JSON.parse(fs.readFileSync(safeConfigPath(), 'utf8'));
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
            return {};
        const record = raw;
        const result = {};
        if (typeof record.enabled === 'boolean')
            result.enabled = record.enabled;
        const mode = normalizeMode(record.mode);
        if (mode)
            result.mode = mode;
        if (typeof record.endpoint === 'string' && (record.endpoint === '' || isLoopbackEndpoint(record.endpoint))) {
            result.endpoint = record.endpoint.trim().replace(/\/+$/, '');
        }
        if (typeof record.model === 'string')
            result.model = record.model.trim().slice(0, 200);
        const timeoutMs = boundedTimeout(record.timeoutMs);
        if (timeoutMs !== null)
            result.timeoutMs = timeoutMs;
        const strictness = normalizeStrictness(record.strictness);
        if (strictness)
            result.strictness = strictness;
        return result;
    }
    catch {
        return {};
    }
}
function writeStoredConfig(config) {
    try {
        const directory = path.dirname(safeConfigPath());
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        fs.writeFileSync(safeConfigPath(), JSON.stringify({ schemaVersion: 1, ...config }, null, 2), {
            encoding: 'utf8',
            mode: 0o600
        });
        fs.chmodSync(safeConfigPath(), 0o600);
    }
    catch (error) {
        auditLog.log({
            event: 'observer_config_write_failed',
            error: error instanceof Error ? error.message : String(error)
        });
    }
}
function confirmThreshold(strictness) {
    if (strictness === 'relaxed')
        return 0.8;
    if (strictness === 'strict')
        return 0.45;
    return 0.62;
}
function nestedError(result) {
    if (result === null || typeof result !== 'object' || Array.isArray(result))
        return '';
    const record = result;
    return typeof record.error === 'string' ? record.error : '';
}
function normalizeOutcome(entry) {
    const args = entry.args && typeof entry.args === 'object' && !Array.isArray(entry.args)
        ? entry.args
        : {};
    const result = entry.result;
    const error = nestedError(result);
    const command = entry.command
        || (typeof args.command === 'string' ? args.command : '')
        || (typeof args.cmd === 'string' ? args.cmd : '');
    return {
        tool: entry.tool,
        args: boundedArgs(args),
        success: entry.success === true && !error,
        error: error.slice(0, 600),
        exitCode: result !== null && typeof result === 'object' && !Array.isArray(result)
            && typeof result.exitCode === 'number'
            ? result.exitCode
            : null,
        command: command.slice(0, 600),
        path: entry.path
            || (typeof args.path === 'string' ? args.path : '')
            || (typeof args.file_path === 'string' ? args.file_path : ''),
        at: 0
    };
}
function claimText(agentClaim) {
    return agentClaim.replace(/\s+/g, ' ').trim().slice(0, 2000);
}
function hasCompletionClaim(claim) {
    return COMPLETION_CLAIMS.some((pattern) => pattern.test(claim));
}
function hasHonestCaveat(claim) {
    return HONEST_CAVEATS.some((pattern) => pattern.test(claim));
}
function failureSummary(outcomes) {
    const last = [...outcomes].reverse().find((outcome) => !outcome.success);
    if (!last)
        return 'a recent tool call failed';
    const detail = last.error || last.command || last.path || 'no error text';
    return `${last.tool} failed: ${detail.slice(0, 180)}`;
}
export class ColdObserver {
    config;
    auditHistory = [];
    journals = new Map();
    advisoryFailures = 0;
    advisoryCooldownUntil = 0;
    static instance = null;
    constructor(configPartial) {
        this.config = { ...DEFAULT_CONFIG, ...readStoredConfig(), ...(configPartial || {}) };
    }
    static getInstance() {
        if (!ColdObserver.instance)
            ColdObserver.instance = new ColdObserver();
        return ColdObserver.instance;
    }
    getConfig() {
        return { ...this.config };
    }
    updateConfig(patch) {
        const next = { ...this.config };
        if (typeof patch.enabled === 'boolean')
            next.enabled = patch.enabled;
        if (patch.mode !== undefined) {
            const mode = normalizeMode(patch.mode);
            if (!mode)
                throw new Error('mode must be deterministic or advisory');
            next.mode = mode;
        }
        if (patch.endpoint !== undefined) {
            const endpoint = String(patch.endpoint).trim().replace(/\/+$/, '');
            if (endpoint && !isLoopbackEndpoint(endpoint)) {
                throw new Error('endpoint must be a loopback HTTP URL');
            }
            next.endpoint = endpoint;
        }
        if (patch.model !== undefined)
            next.model = String(patch.model).trim().slice(0, 200);
        if (patch.timeoutMs !== undefined) {
            const timeoutMs = boundedTimeout(patch.timeoutMs);
            if (timeoutMs === null)
                throw new Error('timeout must be a number');
            next.timeoutMs = timeoutMs;
        }
        if (patch.strictness !== undefined) {
            const strictness = normalizeStrictness(patch.strictness);
            if (!strictness)
                throw new Error('strictness must be relaxed, standard, or strict');
            next.strictness = strictness;
        }
        this.config = next;
        writeStoredConfig(next);
    }
    getAuditHistory() {
        return [...this.auditHistory];
    }
    beginTask(taskId) {
        if (!taskId)
            return;
        this.journals.set(taskId, []);
        while (this.journals.size > MAX_JOURNAL_TASKS) {
            const oldest = this.journals.keys().next().value;
            if (typeof oldest !== 'string')
                break;
            this.journals.delete(oldest);
        }
    }
    recordToolOutcome(taskId, tool, args, result) {
        if (!taskId)
            return;
        const journal = this.journals.get(taskId) ?? [];
        journal.push(outcomeFromResult(tool, args, result, Date.now()));
        if (journal.length > MAX_JOURNAL_OUTCOMES)
            journal.splice(0, journal.length - MAX_JOURNAL_OUTCOMES);
        this.journals.set(taskId, journal);
    }
    getToolOutcomes(taskId) {
        return [...(this.journals.get(taskId) ?? [])];
    }
    recordAudit(entry) {
        this.auditHistory.push(entry);
        if (this.auditHistory.length > MAX_AUDIT_RECORDS) {
            this.auditHistory.splice(0, this.auditHistory.length - MAX_AUDIT_RECORDS);
        }
        auditLog.log({
            event: 'observer_audit',
            type: entry.type,
            tool: entry.tool ?? null,
            riskScore: entry.riskScore ?? 0,
            veto: entry.veto ?? false,
            details: entry.details
        });
    }
    async advisoryReview(toolName, args, context, riskScore, threshold, evidence) {
        if (this.config.mode !== 'advisory')
            return { riskScore, confidence: 0, findings: [] };
        if (!this.config.endpoint || !this.config.model)
            return { riskScore, confidence: 0, findings: [] };
        if (riskScore < 0.2 || riskScore >= threshold)
            return { riskScore, confidence: 0, findings: [] };
        if (Date.now() < this.advisoryCooldownUntil)
            return { riskScore, confidence: 0, findings: [] };
        if (!isLoopbackEndpoint(this.config.endpoint))
            return { riskScore, confidence: 0, findings: [] };
        const verdict = await queryAdvisory({
            tool: toolName,
            args,
            findings: evidence.map((item) => item.detail),
            workspaceRoot: context.workspaceRoot
        }, {
            endpoint: this.config.endpoint,
            model: this.config.model,
            timeoutMs: this.config.timeoutMs
        });
        if (!verdict) {
            this.advisoryFailures += 1;
            if (this.advisoryFailures >= ADVISORY_FAILURE_LIMIT) {
                this.advisoryCooldownUntil = Date.now() + ADVISORY_COOLDOWN_MS;
                this.advisoryFailures = 0;
            }
            return { riskScore, confidence: 0, findings: [] };
        }
        this.advisoryFailures = 0;
        if (verdict.risk <= riskScore || verdict.confidence < 0.5) {
            return { riskScore, confidence: 0, findings: [] };
        }
        const delta = Math.min(0.15, (verdict.risk - riskScore) * verdict.confidence);
        const raised = Math.min(0.97, riskScore + delta);
        evidence.push({
            code: 'advisory-review',
            severity: raised >= 0.78 ? 'high' : 'medium',
            weight: raised,
            confidence: verdict.confidence,
            detail: verdict.observation || `local advisory model raised risk from ${riskScore.toFixed(2)} to ${raised.toFixed(2)}`,
            source: 'advisory'
        });
        return {
            riskScore: raised,
            confidence: verdict.confidence,
            findings: [verdict.observation || 'local advisory model raised the risk estimate']
        };
    }
    async evaluateMutation(toolName, args = {}, context) {
        if (!this.config.enabled) {
            return {
                allowed: true,
                veto: false,
                requiresConfirmation: false,
                riskScore: 0,
                confidence: 0,
                reason: 'observer disabled',
                findings: [],
                evidence: []
            };
        }
        if (!MUTATING_TOOLS.has(toolName)) {
            return {
                allowed: true,
                veto: false,
                requiresConfirmation: false,
                riskScore: 0,
                confidence: 0,
                reason: 'no mutation evidence',
                findings: [],
                evidence: []
            };
        }
        const resolvedContext = {
            workspaceRoot: context?.workspaceRoot || process.cwd()
        };
        const scanned = scanMutation(toolName, args, resolvedContext);
        const evidence = [...scanned.evidence];
        const threshold = confirmThreshold(this.config.strictness);
        const advisory = await this.advisoryReview(toolName, args, resolvedContext, scanned.riskScore, threshold, evidence);
        const riskScore = advisory.riskScore;
        const confidence = Math.max(scanned.confidence, advisory.confidence * 0.8);
        const veto = scanned.veto;
        const requiresConfirmation = !veto && riskScore >= threshold;
        const findings = evidence.map((item) => item.detail);
        for (const finding of advisory.findings) {
            if (!findings.includes(finding))
                findings.push(finding);
        }
        const reason = findings.length > 0
            ? findings.slice(0, 3).join(' | ')
            : 'no destructive evidence found';
        if (veto || requiresConfirmation) {
            this.recordAudit({
                timestamp: Date.now(),
                type: 'mutation',
                tool: toolName,
                riskScore,
                veto,
                details: reason
            });
        }
        return {
            allowed: !veto,
            veto,
            requiresConfirmation,
            riskScore,
            confidence,
            reason,
            findings,
            evidence
        };
    }
    async auditTurnVerification(turnState) {
        if (!this.config.enabled) {
            return { verified: true, overconfident: false, confidence: 0, discrepancy: '', coldDirective: '' };
        }
        const claim = claimText(turnState.agentClaim);
        if (!claim || !hasCompletionClaim(claim)) {
            return { verified: true, overconfident: false, confidence: 0, discrepancy: '', coldDirective: '' };
        }
        const journal = turnState.taskId ? this.journals.get(turnState.taskId) : undefined;
        const isToolOutcome = (entry) => (entry !== null && typeof entry === 'object' && typeof entry.at === 'number');
        const outcomes = journal && journal.length > 0
            ? journal
            : turnState.toolHistory.map((item) => isToolOutcome(item) ? item : normalizeOutcome(item));
        const caveat = hasHonestCaveat(claim);
        const lastFailure = outcomes.findLastIndex((outcome) => !outcome.success);
        const successAfterFailure = lastFailure >= 0
            && outcomes.slice(lastFailure + 1).some((outcome) => outcome.success);
        const isCodeMutation = (outcome) => outcome.success
            && ['fs_write', 'fs_edit', 'MultiEdit', 'write_file', 'write_to_file', 'edit_file', 'replace_file_content', 'multi_replace_file_content', 'write', 'edit', 'multiedit'].includes(outcome.tool)
            && /\.(?:[cm]?[jt]sx?|py|rb|php|go|rs|java|kt|kts|swift|c|cc|cpp|h|hpp|cs|fs|sh|sql|html|css|scss|sass|vue|svelte)$/i.test(outcome.path);
        const lastCodeChange = outcomes.findLastIndex(isCodeMutation);
        const checks = outcomes.slice(lastCodeChange + 1);
        const hasTestRun = checks.some((outcome) => outcome.success
            && (TEST_COMMAND.test(outcome.command) || TEST_COMMAND.test(outcome.tool)));
        const hasBuildRun = checks.some((outcome) => outcome.success
            && (BUILD_OR_CHECK_COMMAND.test(outcome.command) || outcome.tool === 'code_verify_syntax'));
        const modifiedCode = lastCodeChange >= 0;
        const declarativeOnly = modifiedCode && outcomes.filter(isCodeMutation).every(outcome => /\.(?:html|css)$/i.test(outcome.path));
        const hasRenderedCheck = checks.some(outcome => outcome.success && outcome.rendered === true);
        const hasDeclarativeInspection = checks.some(outcome => outcome.success
            && ['fs_read', 'read_file', 'view_file', 'read', 'cat'].includes(outcome.tool)
            && /\.(?:html|css)$/i.test(outcome.path));
        let overconfident = false;
        let confidence = 0;
        let discrepancy = '';
        let coldDirective = '';
        if (!caveat && lastFailure >= 0 && !successAfterFailure) {
            overconfident = true;
            confidence = 0.92;
            discrepancy = `completion claim conflicts with tool evidence: ${failureSummary(outcomes)}`;
            coldDirective = `[OBSERVER] Your completion claim conflicts with the latest tool evidence: ${failureSummary(outcomes)}. Resolve the failure and rerun the failing check before claiming success.`;
        }
        else if (!caveat && TESTS_CLAIM.test(claim) && !hasTestRun) {
            overconfident = true;
            confidence = 0.86;
            discrepancy = 'claimed passing tests without a successful test command in this task';
            coldDirective = '[OBSERVER] You claimed that tests passed, but no successful test command appears in this task. Run the test command and report its actual result, or state plainly that you did not run it.';
        }
        else if (!caveat && BUILD_CLAIM.test(claim) && !hasBuildRun) {
            overconfident = true;
            confidence = 0.82;
            discrepancy = 'claimed a passing build or check without a successful verification command';
            coldDirective = '[OBSERVER] You claimed that a build or check passed, but no successful verification command appears in this task. Run the relevant command and report its actual result, or state that it is unverified.';
        }
        else if (!caveat && modifiedCode && !hasBuildRun && !hasTestRun && !(declarativeOnly && (hasRenderedCheck || hasDeclarativeInspection))) {
            overconfident = true;
            confidence = 0.72;
            discrepancy = 'code was modified without a successful test or syntax check';
            coldDirective = '[OBSERVER] You changed code but there is no successful test or syntax check in this task. Verify the change before finishing, or state plainly that it is unverified.';
        }
        if (overconfident) {
            this.recordAudit({
                timestamp: Date.now(),
                type: 'verification',
                riskScore: confidence,
                veto: false,
                details: discrepancy
            });
        }
        return {
            verified: !overconfident,
            overconfident,
            confidence,
            discrepancy,
            coldDirective
        };
    }
    async healthCheck() {
        if (!this.config.endpoint) {
            return {
                healthy: false,
                endpoint: '',
                model: this.config.model,
                latencyMs: 0,
                detail: 'no endpoint configured'
            };
        }
        const probe = await probeAdvisory({
            endpoint: this.config.endpoint,
            model: this.config.model,
            timeoutMs: this.config.timeoutMs
        });
        return {
            healthy: probe.healthy,
            endpoint: this.config.endpoint,
            model: this.config.model,
            latencyMs: probe.latencyMs,
            detail: probe.detail
        };
    }
}
export const coldObserver = ColdObserver.getInstance();
