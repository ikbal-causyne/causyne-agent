/**
 * Causyne resource policy, version 2.
 *
 * Design invariant: an inferred task category, autonomy mode or provider name
 * must NEVER fabricate a hard resource ceiling. Explicit user/worker ceilings
 * remain hard. Default thresholds are advisory telemetry only.
 *
 * Native tool-stall protections and provider operation timeouts are separate
 * safety controls and remain active outside this policy.
 */
export const DEFAULT_AGY_TASK_TOKENS = 80_000; // non-blocking advisory only
export const DEFAULT_AGY_CALL_TOKENS = 32_000; // non-blocking advisory only
export const DEFAULT_AGY_NATIVE_ACTIONS = 128; // retained for UI guidance only
export const DEFAULT_DESKTOP_NATIVE_ACTIONS = 12; // retained for UI guidance only
export const DESKTOP_TASK_WALL_MS = 180_000; // legacy hint, not a default deadline
const TERMINAL_BUDGET_CODES = new Set([
    'TASK_TOKEN_BUDGET', 'PROVIDER_TOKEN_BUDGET',
    'AGY_DESKTOP_TASK_LIMIT', 'AGY_TOKEN_BUDGET',
    'AGY_NATIVE_ACTION_BUDGET', 'AGY_TASK_DEADLINE', 'TASK_WALL_BUDGET'
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
/** Only an explicit worker limit or enabled, HARD user budget can stop a task. */
export function resolveTaskTokenCeiling(options) {
    const worker = positiveSafeInteger(options.workerLimit);
    const configured = options.configured?.enabled === true && options.configured.hardStop === true
        ? positiveSafeInteger(options.configured.maxTokensPerTask)
        : null;
    if (worker === null)
        return configured;
    if (configured === null)
        return worker;
    return Math.min(worker, configured);
}
/**
 * The entire remaining explicitly authorized ceiling is usable in one call.
 * No silent 32k sub-ceiling: doing so discards successful peer output.
 * Missing/unbounded input means no token checkpoint, not a hidden default.
 * Zero is an explicit exhausted limit.
 */
export function peerCallTokenCeiling(remaining) {
    if (remaining === 0 || remaining === '0')
        return 0;
    return positiveSafeInteger(remaining);
}
/**
 * Native action count becomes a hard stop only when an explicit option is set.
 * Independently, the peer's repetition / no-progress circuit breakers remain.
 */
export function peerNativeActionCeiling(configured, _desktopTask) {
    if (configured === 0 || configured === '0')
        return 0;
    return positiveSafeInteger(configured);
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
/** User opt-in only: the old 180-second desktop hard stop was task-breaking. */
export function desktopDeadline(startMs, archetype, hardWallMs) {
    const limit = positiveSafeInteger(hardWallMs);
    if (archetype !== 'desktop_personalization' || !Number.isFinite(startMs) || limit === null)
        return null;
    const deadline = startMs + limit;
    return Number.isSafeInteger(deadline) ? deadline : null;
}
export function remainingDesktopTime(deadlineMs, nowMs = Date.now()) {
    if (typeof deadlineMs !== 'number' || !Number.isFinite(deadlineMs))
        return null;
    return Math.max(0, Math.floor(deadlineMs - nowMs));
}
export function createBudgetError(code, message) {
    return Object.assign(new Error(message), { code });
}
