/**
 * Causyne Agent — Error Classifier & Retry Guidance (Sector 3)
 *
 * Extracted from `AgentLoop` into a standalone Strict TypeScript module so error
 * classification and retry hints are independently testable and honor structured
 * HTTP/network metadata (`ProviderHttpError.status`, `code: 'ETIMEDOUT'`, partial usage).
 */
export function classifyAgentError(error) {
    const errObj = typeof error === 'object' && error !== null ? error : null;
    if (errObj?.code === 'PROVIDER_NO_PROGRESS')
        return 'fatal';
    if (errObj?.code === 'AGY_NATIVE_ACTION_DENIED' ||
        errObj?.code === 'AGY_NATIVE_ACTION_BUDGET' ||
        errObj?.code === 'AGY_DESKTOP_TASK_LIMIT') {
        return 'fatal';
    }
    // A provider may have charged for completed steps before the turn failed.
    // Replaying that turn can repeat actions and spend the same tokens again.
    const spent = Number(errObj?.partialUsage?.promptTokens || 0) +
        Number(errObj?.partialUsage?.completionTokens || 0);
    if (spent > 0)
        return 'fatal';
    const msg = (typeof error === 'string'
        ? error
        : typeof errObj?.message === 'string'
            ? errObj.message
            : '').toLowerCase();
    if (errObj?.name === 'OpenRouterPrivacyConstraintError' ||
        msg.includes('matching the privacy policy') ||
        msg.includes('data_collection=')) {
        return 'fatal';
    }
    if (msg.includes('free usage limit') ||
        msg.includes('subscribe to opencode') ||
        msg.includes('opencode.ai/go') ||
        msg.includes('insufficient_quota') ||
        msg.includes('credit balance is too low')) {
        return 'fatal';
    }
    // Honor structured HTTP status codes and transport error codes directly
    const status = typeof errObj?.status === 'number' ? errObj.status : null;
    if (status === 429)
        return 'rate_limit';
    if (status === 401 || status === 403)
        return 'auth_error';
    if (status === 400)
        return 'invalid_request_error';
    if (status !== null && status >= 500 && status <= 599)
        return 'network_error';
    if (errObj?.code === 'ETIMEDOUT' ||
        errObj?.code === 'ECONNREFUSED' ||
        errObj?.code === 'ECONNRESET') {
        return 'network_error';
    }
    if (msg.includes('syntax') || msg.includes('unexpected token') || msg.includes('invalid json')) {
        return 'syntax_error';
    }
    if (msg.includes('enoent') ||
        msg.includes('no such file') ||
        msg.includes('not found') ||
        msg.includes('does not exist')) {
        return 'path_not_found';
    }
    if (msg.includes('econnrefused') ||
        msg.includes('econnreset') ||
        msg.includes('etimedout') ||
        msg.includes('fetch failed') ||
        msg.includes('network')) {
        return 'network_error';
    }
    if (msg.includes('rate limit') ||
        msg.includes('429') ||
        msg.includes('too many requests') ||
        msg.includes('quota')) {
        return 'rate_limit';
    }
    if (msg.includes('eacces') || msg.includes('permission denied') || msg.includes('eperm')) {
        return 'permission_denied';
    }
    if (msg.includes('401') ||
        msg.includes('403') ||
        msg.includes('unauthorized') ||
        msg.includes('api key')) {
        return 'auth_error';
    }
    if (msg.includes('400') ||
        msg.includes('invalid_parameter') ||
        msg.includes('invalid_request') ||
        msg.includes('required property') ||
        msg.includes('bad request')) {
        return 'invalid_request_error';
    }
    if (msg.includes('kill') || msg.includes('abort') || msg.includes('signal') || msg.includes('fatal')) {
        return 'fatal';
    }
    if (error instanceof TypeError || error instanceof ReferenceError || error instanceof RangeError) {
        return 'fatal';
    }
    return 'unknown_error';
}
const RETRY_HINTS = {
    syntax_error: 'Check your command syntax or JSON structure. Ensure quotes are balanced.',
    path_not_found: 'The file or directory does not exist. Use fs.list to verify the path first, or create it with fs.write/mkdir.',
    network_error: 'Network connectivity issue. Wait a moment and retry. If persistent, check if the URL is correct.',
    rate_limit: 'API rate limit hit. Wait 5-10 seconds before retrying.',
    permission_denied: 'Permission denied. Check if the path is within allowed workspace paths. Try a different directory.',
    auth_error: 'Authentication failed. Do NOT retry — the API key may be invalid.',
    invalid_request_error: 'API request format error (400 Bad Request). Do NOT retry — check model parameter compliance.',
    unknown_error: 'An unexpected error occurred. Try a different approach entirely.'
};
export function getRetryHintForError(errorType) {
    return RETRY_HINTS[errorType] ?? RETRY_HINTS.unknown_error;
}
