/** Normalize arbitrary provider throws before the AgentLoop error handler. */
export interface AgentFailure extends Error {
  code?: unknown;
  partialUsage?: unknown;
  status?: unknown;
  reason?: unknown;
}

function compactMessage(value: unknown): string {
  if (typeof value === 'string') return value.slice(0, 4096);
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (value === null || value === undefined) return 'Unknown provider error';
  try {
    const text = String(value);
    return text.length > 4096 ? `${text.slice(0, 4096)}…` : text;
  } catch {
    return 'Provider threw a value that could not be stringified';
  }
}

export function normalizeAgentFailure(value: unknown): AgentFailure {
  if (value instanceof Error) return value as AgentFailure;

  const candidate: Record<string, unknown> = value && typeof value === 'object'
    ? value as Record<string, unknown> : {};
  const sourceMessage = typeof candidate.message === 'string' ? candidate.message : value;
  const error = new Error(compactMessage(sourceMessage)) as AgentFailure;
  for (const field of ['code', 'partialUsage', 'status', 'reason'] as const) {
    if (Object.hasOwn(candidate, field)) error[field] = candidate[field];
  }
  if (typeof candidate.name === 'string') error.name = candidate.name;
  return error;
}
