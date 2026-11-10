/**
 * Causyne peer budget policy. No model calls, filesystem writes, or global state.
 * One task token ceiling is shared by the AgentLoop and TokenTracker.
 * Provider-local ceilings stop a headless peer before it can consume an entire
 * task budget in one internal multi-step CLI invocation.
 */
export const DEFAULT_AGY_TASK_TOKENS = 80_000;
export const DEFAULT_AGY_CALL_TOKENS = 32_000;
export const DEFAULT_AGY_NATIVE_ACTIONS = 128;
export const DEFAULT_DESKTOP_NATIVE_ACTIONS = 12;
export const DESKTOP_TASK_WALL_MS = 180_000;
const TERMINAL_BUDGET_CODES = new Set([
    'TASK_TOKEN_BUDGET',
    'PROVIDER_TOKEN_BUDGET',
    'AGY_DESKTOP_TASK_LIMIT',
    'AGY_TOKEN_BUDGET',
    'AGY_NATIVE_ACTION_BUDGET',
    'AGY_TASK_DEADLINE',
    'TASK_WALL_BUDGET'
]);
export function positiveSafeInteger(value) {
    if (typeof value !== 'number' && typeof value !== 'string')
        return null;
    if (typeof value === 'string' && !/^\d+$/.test(value.trim()))
        return null;
    const n = Number(value);
    return Number.isSafeInteger(n) && n > 0 ? n : null;
}
export function isAntigravityPeer(provider) {
    return /^(?:antigravity|agy)(?:$|[/:\s])/i.test(String(provider ?? '').trim());
}
/**
 * Explicit worker ceiling remains strict. An enabled user task limit is
 * authoritative even if its previous 'hardStop' flag was false. In the absence
 * of explicit limits, only Antigravity peers get the conservative default.
 * Other BYOK providers retain their existing policy.
 */
export function resolveTaskTokenCeiling(options) {
    const worker = positiveSafeInteger(options.workerLimit);
    const configured = options.configured?.enabled === true
        ? positiveSafeInteger(options.configured.maxTokensPerTask)
        : null;
    const explicit = [worker, configured].filter((v) => v !== null);
    if (explicit.length > 0)
        return Math.min(...explicit);
    return isAntigravityPeer(options.provider) ? DEFAULT_AGY_TASK_TOKENS : null;
}
/** A finite peer call bound even when the caller passes hardBudget:false. */
export function peerCallTokenCeiling(remaining) {
    const configuredRemaining = typeof remaining === 'number' && Number.isFinite(remaining)
        ? Math.max(0, Math.floor(remaining)) : null;
    return configuredRemaining === null
        ? DEFAULT_AGY_CALL_TOKENS
        : Math.min(DEFAULT_AGY_CALL_TOKENS, configuredRemaining);
}
export function peerNativeActionCeiling(configured, desktopTask) {
    const fallback = desktopTask ? DEFAULT_DESKTOP_NATIVE_ACTIONS : DEFAULT_AGY_NATIVE_ACTIONS;
    // Zero explicitly disables native peer actions; it is not 'missing'.
    const explicit = typeof configured === 'number' && Number.isSafeInteger(configured)
        && configured >= 0 ? configured : positiveSafeInteger(configured);
    return explicit === null ? fallback : Math.min(explicit, fallback);
}
export function isTerminalBudgetFailure(error) {
    if (!error || typeof error !== 'object')
        return false;
    const code = error.code;
    return typeof code === 'string' && TERMINAL_BUDGET_CODES.has(code);
}
export function hasBillablePartialUsage(error) {
    if (!error || typeof error !== 'object')
        return false;
    const usage = error.partialUsage;
    if (!usage || typeof usage !== 'object')
        return false;
    const record = usage;
    return [record.promptTokens, record.completionTokens].some(value => typeof value === 'number' && Number.isFinite(value) && value > 0);
}
export function shouldRetryPeerError(error, aborted = false) {
    return !aborted && !isTerminalBudgetFailure(error) && !hasBillablePartialUsage(error);
}
export function desktopDeadline(startMs, archetype) {
    return archetype === 'desktop_personalization' && Number.isFinite(startMs)
        ? startMs + DESKTOP_TASK_WALL_MS : null;
}
export function remainingDesktopTime(deadlineMs, nowMs = Date.now()) {
    if (typeof deadlineMs !== 'number' || !Number.isFinite(deadlineMs))
        return null;
    return Math.max(0, Math.floor(deadlineMs - nowMs));
}
export function createBudgetError(code, message) {
    return Object.assign(new Error(message), { code });
}
