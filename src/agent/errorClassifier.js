/**
 * Causyne Agent — Error Classifier & Retry Guidance (Sector 3)
 *
 * Extracted from `AgentLoop` into a standalone Strict TypeScript module so error
 * classification and retry hints are independently testable and honor structured
 * HTTP/network metadata (`ProviderHttpError.status`, `code: 'ETIMEDOUT'`, partial usage).
 */
export function classifyAgentError(error) {
    const errObj = typeof error === 'object' && error !== null ? error : null;
    if (errObj?.code === 'PROVIDER_NO_PROGRESS' || errObj?.code === 'ACP_PARTIAL_TURN')
        return 'fatal';
    if (errObj?.code === 'AGY_NATIVE_ACTION_DENIED' ||
        errObj?.code === 'AGY_NATIVE_ACTION_BUDGET' ||
        errObj?.code === 'AGY_DESKTOP_TASK_LIMIT') {
        return 'fatal';
    }
    // A provider may have charged for completed steps before the turn failed.
    // Replaying that turn can repeat actions and spend the same tokens again.
    const posTokens = (v) => {
        if (typeof v !== 'number' && typeof v !== 'string') return 0;
        const n = Number(v);
        return Number.isFinite(n) && n > 0 ? n : 0;
    };
    const spent = posTokens(errObj?.partialUsage?.promptTokens) +
        posTokens(errObj?.partialUsage?.completionTokens);
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
    const isContextOverflowMsg = msg.includes('context_length_exceeded') ||
        msg.includes('maximum context length') ||
        msg.includes('prompt is too long') ||
        msg.includes('input is too long') ||
        msg.includes('too many tokens') ||
        msg.includes('exceeds the context window') ||
        msg.includes('request too large') ||
        msg.includes('payload too large');
    if (status === 413 || isContextOverflowMsg)
        return 'context_overflow';
    if (status === 429)
        return 'rate_limit';
    if (status === 401 || status === 403)
        return 'auth_error';
    if (status === 400 || status === 404 || status === 422)
        return 'invalid_request_error';
    if (status === 408 || status === 529 || (status !== null && status >= 500 && status <= 599))
        return 'network_error';
    const causeCode = errObj?.cause?.code ?? errObj?.cause?.errno;
    if (typeof causeCode === 'string' && ['ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(causeCode))
        return 'network_error';
    if (errObj?.name === 'TimeoutError' ||
        errObj?.code === 'ETIMEDOUT' ||
        errObj?.code === 'ECONNREFUSED' ||
        errObj?.code === 'ECONNRESET' ||
        errObj?.code === 'EPIPE' ||
        errObj?.code === 'ENOTFOUND' ||
        errObj?.code === 'EAI_AGAIN' ||
        errObj?.code === 'UND_ERR_CONNECT_TIMEOUT' ||
        errObj?.code === 'UND_ERR_HEADERS_TIMEOUT' ||
        errObj?.code === 'UND_ERR_BODY_TIMEOUT' ||
        errObj?.code === 'UND_ERR_SOCKET' ||
        errObj?.code === 'ENETUNREACH' ||
        errObj?.code === 'EHOSTUNREACH' ||
        errObj?.code === 'ECONNABORTED') {
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
        msg.includes('cannot connect to api') ||
        msg.includes('socket connection was closed') ||
        msg.includes('socket hang up') ||
        msg.includes('connection lost') ||
        msg.includes('overloaded_error') ||
        msg.includes('service unavailable') ||
        msg.includes('bad gateway') ||
        msg.includes('gateway timeout') ||
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
    if (/\b(?:kill|killed|sigkill|sigterm|sigint)\b/.test(msg) ||
        msg.includes('abort') ||
        msg.includes('signal') ||
        msg.includes('fatal')) {
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
    context_overflow: 'Conversation exceeded the model context window. Compact older tool outputs and retry.',
    permission_denied: 'Permission denied. Check if the path is within allowed workspace paths. Try a different directory.',
    auth_error: 'Authentication failed. Do NOT retry — the API key may be invalid.',
    invalid_request_error: 'API request format error (400 Bad Request). Do NOT retry — check model parameter compliance.',
    unknown_error: 'An unexpected error occurred. Try a different approach entirely.'
};
export function getRetryHintForError(errorType) {
    return RETRY_HINTS[errorType] ?? RETRY_HINTS.unknown_error;
}
