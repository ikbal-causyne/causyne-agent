/**
 * Keep the full execution trail, but collapse the second, visually redundant
 * success row once a long tool-heavy run is underway. A failure, a non-empty
 * output, a diagnostic, or any missing result stays expanded.
 *
 * Only the presentation changes. Original tool results still pass through
 * captureLastOutput() and the AgentLoop is not affected.
 */
export const TOOL_ACTIVITY_COMPACT_AFTER = 8;

export function compactSuccessfulToolResult(stepCount, result, tail, toolName) {
  if (!Number.isFinite(stepCount) || stepCount < TOOL_ACTIVITY_COMPACT_AFTER) return false;
  if (!result || result.success !== true) return false;
  if (!tail || tail.kind !== 'step' || !tail.meta) return false;
  if (tail.meta.step !== stepCount || String(tail.meta.tool ?? '') !== String(toolName ?? '')) return false;
  // Only truly silent successes qualify. Unknown provider-specific result
  // fields must remain visible, rather than being hidden by an allowlist of
  // familiar output property names.
  const metadataOnly = new Set([
    'success', 'exitCode', 'exit_code', 'durationMs', 'elapsedMs', 'duration',
    'statusCode', 'status_code'
  ]);
  for (const [key, value] of Object.entries(result)) {
    if (metadataOnly.has(key)) continue;
    if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) continue;
    return false;
  }
  return true;
}
