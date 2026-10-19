// The tool-dispatch discipline: permission → pre-hook → execute → post-hook → result.
//
// Ported from the reference agent loop (claw-code rust/crates/runtime/src/
// conversation.rs:201-254). The single rule that matters: a denial or a failure
// is NEVER thrown out of the loop — it comes back as a tool result with an error
// flag, so the model sees it and self-corrects. Only a fatal/auth/transport error
// (handled by the caller) ends the turn.
//
// This is pure logic with no I/O of its own: the caller injects `authorize`,
// `preHook`, `postHook` and `execute`. That is what makes the agent loop's tool
// handling testable for the first time — a scripted set of these four functions
// exercises deny → result, execute → result, throw → recovered-not-fatal without
// a live model or a real filesystem.
//
// Pure Node. No dependency, no shell.

/**
 * A tool-result message in the shape the providers expect, matching what
 * agentLoop.js already pushes: { role:'tool', tool_call_id, name, content }
 * where content is a JSON string carrying at least { success }.
 */
export function toolResultMessage(toolCallId, name, payload) {
  return {
    role: 'tool',
    tool_call_id: toolCallId,
    name,
    content: JSON.stringify(payload)
  };
}

/**
 * Fold hook feedback lines into a result payload.
 *
 * Hook stdout is model-visible feedback, not a log line (the reference appends it
 * to the tool output). `denied` marks it as the reason a call was refused.
 */
export function mergeHookFeedback(payload, messages, denied = false) {
  if (!messages || messages.length === 0) return payload;
  const label = denied ? 'Hook feedback (denied)' : 'Hook feedback';
  const note = `${label}:\n${messages.join('\n')}`;
  const existing = typeof payload.hookFeedback === 'string' ? payload.hookFeedback + '\n' : '';
  return { ...payload, hookFeedback: existing + note };
}

const ALLOW = { denied: false, messages: [] };

/**
 * Run one tool call through the discipline and return a result message.
 *
 * Injected functions (all optional except execute):
 *   authorize(name, args) -> { allow:true } | { allow:false, reason }
 *   preHook(name, args)   -> { denied, messages }        (Stage 3 fills this in)
 *   execute(name, args)   -> any payload, or throws
 *   postHook(name, args, payload, isError) -> { denied, messages }
 *
 * Returns { message, denied, isError }. Never throws for a tool-level failure —
 * a thrown execute() becomes an is_error result. The caller decides, from the
 * result, whether to break (it never should for a tool error) or continue.
 */
export async function dispatchToolCall({
  toolCallId,
  name,
  args = {},
  authorize = null,
  preHook = null,
  postHook = null,
  execute
}) {
  // 1. Permission. A denial is a result, not an exception.
  if (authorize) {
    const decision = authorize(name, args) || {};
    if (decision.allow === false) {
      return {
        denied: true,
        isError: true,
        message: toolResultMessage(toolCallId, name, {
          success: false,
          error: decision.reason || `Tool "${name}" was not permitted.`
        })
      };
    }
  }

  // 2. PreToolUse hook. Denial short-circuits before execute.
  const pre = (preHook ? await preHook(name, args) : ALLOW) || ALLOW;
  if (pre.denied) {
    return {
      denied: true,
      isError: true,
      message: toolResultMessage(toolCallId, name, mergeHookFeedback(
        { success: false, error: `PreToolUse hook denied tool "${name}".` },
        pre.messages,
        true
      ))
    };
  }

  // 3. Execute. A throw becomes an is_error result — never propagated.
  let payload;
  let isError = false;
  try {
    payload = await execute(name, args);
    if (payload == null) payload = { success: true };
    if (typeof payload !== 'object') payload = { success: true, output: payload };
    if (payload.success === undefined) payload.success = true;
  } catch (error) {
    isError = true;
    payload = { success: false, error: error && error.message ? error.message : String(error) };
  }

  // Pre-hook feedback rides along even on a successful call.
  payload = mergeHookFeedback(payload, pre.messages, false);

  // 4. PostToolUse hook. Can flip a success to an error and add feedback.
  const post = (postHook ? await postHook(name, args, payload, isError) : ALLOW) || ALLOW;
  if (post.denied) {
    isError = true;
    payload = { ...payload, success: false };
  }
  payload = mergeHookFeedback(payload, post.messages, post.denied);

  return {
    denied: false,
    isError,
    message: toolResultMessage(toolCallId, name, payload)
  };
}
