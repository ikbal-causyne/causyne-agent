/**
 * Repair only *missing* replies to already-recorded assistant tool calls.
 *
 * The AgentLoop appends an assistant tool_calls message before dispatch. If a
 * user aborts a multi-call batch (or the process rejects a later tool), history
 * can contain an unanswered tool call. Providers may reject the next request.
 * This utility never runs a tool, replays an edit, or claims that a missing
 * outcome was a success. It records an explicit unknown/unfinished outcome.
 *
 * IMPORTANT: An image result may insert a `user` media message *between* two
 * tool results. Consequently a turn ends at the NEXT assistant message, not
 * the next user message; otherwise valid image-enabled batches get corrupted.
 */

export interface RecordedToolCall {
  id?: unknown;
  function?: { name?: unknown } | null;
  [key: string]: unknown;
}

export interface RecordedMessage {
  role?: unknown;
  tool_calls?: unknown;
  tool_call_id?: unknown;
  name?: unknown;
  content?: unknown;
  [key: string]: unknown;
}

export interface ToolTurnRepairReport {
  repaired: number;
  affectedTurns: number;
  unresolved: number;
}

const UNCERTAIN_OUTCOME = JSON.stringify({
  success: false,
  code: 'TOOL_OUTCOME_UNRECORDED',
  error: 'The conversation has no recorded outcome for this tool call. ' +
    'The operation may or may not have executed before interruption. ' +
    'Inspect actual workspace state before deciding whether to retry.'
});

function assistantToolCalls(message: RecordedMessage): RecordedToolCall[] {
  if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) return [];
  return message.tool_calls.filter(
    (entry: unknown): entry is RecordedToolCall => entry !== null && typeof entry === 'object'
  );
}

function toolCallId(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : null;
}

/**
 * Mutates only the supplied history array. Returns the number of inserted
 * uncertainty records; does not remove or rewrite a real result.
 *
 * `unresolved > 0` means malformed provider tool IDs or an oversized batch.
 * The caller must stop before another provider request instead of presenting
 * that history as complete.
 */
export function repairUnansweredToolCalls(
  history: RecordedMessage[],
  maxCallsPerTurn = 256
): ToolTurnRepairReport {
  if (!Array.isArray(history)) throw new TypeError('History must be an array');
  if (!Number.isSafeInteger(maxCallsPerTurn) || maxCallsPerTurn < 1) {
    throw new RangeError('maxCallsPerTurn must be a positive integer');
  }

  let repaired = 0;
  let affectedTurns = 0;
  let unresolved = 0;

  for (let i = 0; i < history.length; i++) {
    const message = history[i];
    if (!message) continue;
    const calls = assistantToolCalls(message);
    if (calls.length === 0) continue;
    if (calls.length > maxCallsPerTurn) {
      unresolved += calls.length;
      continue;
    }

    const required = new Map<string, { count: number; name: string }>();
    for (const call of calls) {
      const id = toolCallId(call.id);
      if (!id) {
        unresolved++;
        continue;
      }
      const entry = required.get(id);
      const name = typeof call.function?.name === 'string' && call.function.name
        ? call.function.name
        : 'unknown_tool';
      if (entry) {
        // Provider-issued IDs must be unique within one assistant turn.
        // Do not silently relabel an ambiguous call.
        entry.count++;
        unresolved++;
      } else required.set(id, { count: 1, name });
    }
    if (required.size === 0) continue;

    // This includes internal system notices and injected image observations.
    // Neither constitutes a new assistant tool turn.
    let end = i + 1;
    while (end < history.length && history[end]?.role !== 'assistant') end++;

    const received = new Map<string, number>();
    let insertion = i + 1;
    for (let k = i + 1; k < end; k++) {
      const next = history[k];
      if (next?.role !== 'tool') continue;
      insertion = k + 1;
      const id = toolCallId(next.tool_call_id);
      if (id && required.has(id)) received.set(id, (received.get(id) ?? 0) + 1);
    }

    const missing: RecordedMessage[] = [];
    for (const [id, expected] of required) {
      const count = Math.max(0, expected.count - (received.get(id) ?? 0));
      for (let n = 0; n < count; n++) {
        missing.push({ role: 'tool', tool_call_id: id, name: expected.name, content: UNCERTAIN_OUTCOME });
      }
    }
    if (missing.length === 0) continue;
    history.splice(insertion, 0, ...missing);
    repaired += missing.length;
    affectedTurns++;
    // Move on: inserted tool records are not assistant messages.
  }
  return { repaired, affectedTurns, unresolved };
}

export interface ToolBatchValidation {
  valid: boolean;
  reason: string;
}

/**
 * Check a provider batch *before* prefetch or execution. Duplicate IDs can
 * alias the prefetch map and break the one-result-per-call wire contract.
 * We reject that batch rather than inventing replacement IDs for requests a
 * remote provider might already have associated with the original IDs.
 */
export function validateToolCallBatch(calls: unknown, maxCalls = 256): ToolBatchValidation {
  if (calls === undefined || calls === null) return { valid: true, reason: '' };
  if (!Array.isArray(calls)) return { valid: false, reason: 'toolCalls was not an array' };
  if (calls.length > maxCalls) return { valid: false, reason: `toolCalls exceeded the ${maxCalls}-call safety limit` };
  const seen = new Set<string>();
  for (let index = 0; index < calls.length; index++) {
    const call = calls[index] as RecordedToolCall | null;
    const id = call && toolCallId(call.id);
    if (!id) return { valid: false, reason: `tool call ${index + 1} had no valid ID` };
    if (seen.has(id)) return { valid: false, reason: `duplicate tool-call ID in one assistant turn` };
    const name = call?.function?.name;
    if (typeof name !== 'string' || name.length === 0) {
      return { valid: false, reason: `tool call ${index + 1} had no function name` };
    }
    seen.add(id);
  }
  return { valid: true, reason: '' };
}
