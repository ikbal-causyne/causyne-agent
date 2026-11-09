/**
 * Presentation-only compaction of completed, silent tool steps.
 *
 * Never drop errors, unknown diagnostics, structured results, or output. The
 * AgentLoop's execution contract and underlying result object are unchanged.
 * This TypeScript file is the single source of truth; `toolActivityPolicy.js`
 * is the existing runtime compiler's emitted output.
 */

export const TOOL_ACTIVITY_COMPACT_AFTER = 8;

export interface ToolActivityFrame {
  readonly kind?: string;
  readonly meta?: Readonly<Record<string, unknown>> | null;
}

const METADATA_ONLY = new Set([
  'success', 'exitCode', 'exit_code', 'durationMs', 'elapsedMs',
  'duration', 'statusCode', 'status_code'
]);

/** Returns true only for a known silent success that can share its step row. */
export function compactSuccessfulToolResult(
  stepCount: number,
  result: unknown,
  tail: ToolActivityFrame | null | undefined,
  toolName: unknown
): boolean {
  if (!Number.isFinite(stepCount) || stepCount < TOOL_ACTIVITY_COMPACT_AFTER) return false;
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return false;
  const record = result as Readonly<Record<string, unknown>>;
  if (record.success !== true) return false;
  if (!tail || tail.kind !== 'step' || !tail.meta) return false;
  if (tail.meta.step !== stepCount || String(tail.meta.tool ?? '') !== String(toolName ?? '')) return false;

  for (const [key, value] of Object.entries(record)) {
    if (METADATA_ONLY.has(key)) continue;
    if (value == null || value === '' || (Array.isArray(value) && value.length === 0)) continue;
    return false;
  }
  return true;
}
