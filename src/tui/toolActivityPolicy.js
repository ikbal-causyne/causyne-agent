/**
 * Presentation-only compaction of completed, silent tool steps.
 *
 * Never drop errors, unknown diagnostics, structured results, or output. The
 * AgentLoop's execution contract and underlying result object are unchanged.
 * This TypeScript file is the single source of truth; `toolActivityPolicy.js`
 * is the existing runtime compiler's emitted output.
 */
export const TOOL_ACTIVITY_COMPACT_AFTER = 8;
const METADATA_ONLY = new Set([
    'success', 'exitCode', 'exit_code', 'durationMs', 'elapsedMs',
    'duration', 'statusCode', 'status_code'
]);
/** Returns true only for a known silent success that can share its step row. */
export function compactSuccessfulToolResult(stepCount, result, tail, toolName) {
    if (!Number.isFinite(stepCount) || stepCount < TOOL_ACTIVITY_COMPACT_AFTER)
        return false;
    if (result === null || typeof result !== 'object' || Array.isArray(result))
        return false;
    const record = result;
    if (record.success !== true)
        return false;
    if (!tail || tail.kind !== 'step' || !tail.meta)
        return false;
    if (tail.meta.step !== stepCount || String(tail.meta.tool ?? '') !== String(toolName ?? ''))
        return false;
    for (const [key, value] of Object.entries(record)) {
        if (METADATA_ONLY.has(key)) {
            if ((key === 'exitCode' || key === 'exit_code') && value != null
                && (typeof value !== 'number' || !Number.isFinite(value) || value !== 0))
                return false;
            if ((key === 'statusCode' || key === 'status_code') && value != null
                && (typeof value !== 'number' || !Number.isFinite(value) || value < 200 || value >= 400))
                return false;
            continue;
        }
        if (value == null || value === '' || (Array.isArray(value) && value.length === 0))
            continue;
        return false;
    }
    return true;
}
