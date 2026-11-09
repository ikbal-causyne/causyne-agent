/**
 * Permission -> PreToolUse -> execute -> PostToolUse -> result.
 *
 * TypeScript successor to toolDispatch.js. This is a deliberately narrow
 * migration: names, result-message shape, and exported public functions stay
 * compatible. Authorization may be asynchronous; it must always be awaited
 * before a tool can execute. A failed payload must never report isError=false.
 */
function errorString(error) {
    if (error instanceof Error)
        return error.message;
    return typeof error === 'string' ? error : String(error);
}
export function toolResultMessage(toolCallId, name, payload) {
    return { role: 'tool', tool_call_id: toolCallId, name, content: JSON.stringify(payload) };
}
export function mergeHookFeedback(payload, messages, denied = false) {
    if (!messages || messages.length === 0)
        return payload;
    const title = denied ? 'Hook feedback (denied)' : 'Hook feedback';
    const note = `${title}:\n${messages.join('\n')}`;
    const existing = typeof payload.hookFeedback === 'string' ? `${payload.hookFeedback}\n` : '';
    return { ...payload, hookFeedback: existing + note };
}
function failed(toolCallId, name, error, denied = false) {
    return { denied, isError: true, message: toolResultMessage(toolCallId, name, { success: false, error }) };
}
function normalizePayload(value) {
    if (value === null || value === undefined)
        return { success: true };
    if (value instanceof Error)
        return { success: false, error: value.message };
    if (typeof value !== 'object' || Array.isArray(value))
        return { success: true, output: value };
    const payload = { ...value };
    if (typeof payload.success !== 'boolean') {
        payload.success = typeof payload.error === 'string' ? false : true;
    }
    return payload;
}
export async function dispatchToolCall({ toolCallId, name, args = {}, authorize = null, preHook = null, postHook = null, execute }) {
    // Authorization failures are denials, never permission to proceed.
    try {
        if (authorize) {
            const decision = await authorize(name, args);
            if (decision?.allow !== true) {
                return failed(toolCallId, name, decision?.reason || `Tool "${name}" was not permitted.`, true);
            }
        }
    }
    catch (error) {
        return failed(toolCallId, name, `Authorization failed for "${name}": ${errorString(error)}`, true);
    }
    let pre;
    try {
        pre = await preHook?.(name, args) ?? { denied: false, messages: [] };
    }
    catch (error) {
        return failed(toolCallId, name, `PreToolUse hook failed for "${name}": ${errorString(error)}`, true);
    }
    if (pre.denied) {
        const payload = mergeHookFeedback({ success: false, error: `PreToolUse hook denied tool "${name}".` }, pre.messages, true);
        return { denied: true, isError: true, message: toolResultMessage(toolCallId, name, payload) };
    }
    let payload;
    try {
        payload = normalizePayload(await execute(name, args));
    }
    catch (error) {
        payload = { success: false, error: errorString(error) };
    }
    let isError = payload.success === false || typeof payload.error === 'string';
    payload = mergeHookFeedback(payload, pre.messages);
    // A post-hook can reject the outcome but cannot undo an already executed
    // side effect. Expose that uncertainty instead of returning false success.
    let post;
    try {
        post = await postHook?.(name, args, payload, isError) ?? { denied: false, messages: [] };
    }
    catch (error) {
        post = { denied: true, messages: [`PostToolUse hook raised: ${errorString(error)}`] };
    }
    if (post.denied) {
        isError = true;
        payload = { ...payload, success: false, error: payload.error ||
                'PostToolUse hook denied or failed after execution; inspect actual side effects before retry.' };
    }
    payload = mergeHookFeedback(payload, post.messages, Boolean(post.denied));
    isError ||= payload.success === false || typeof payload.error === 'string';
    return { denied: false, isError, message: toolResultMessage(toolCallId, name, payload) };
}
