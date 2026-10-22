/**
 * Agent Client Protocol (ACP) types for Causyne Agent.
 *
 * JSON-RPC 2.0 over stdio with newline-delimited framing. The shapes here
 * follow the published ACP schema; the agent advertises only the capabilities
 * it actually implements.
 */
export const ACP_PROTOCOL_VERSION = 1;
export const ACP_METHODS = {
    INITIALIZE: 'initialize',
    NEW_SESSION: 'session/new',
    PROMPT: 'session/prompt',
    CANCEL: 'session/cancel',
    UPDATE: 'session/update',
    LOAD: 'session/load',
    FORK: 'session/fork',
    LIST: 'session/list',
    CLOSE: 'session/close',
    SET_MODE: 'session/set_mode',
    SET_MODEL: 'session/set_model',
    AUTHENTICATE: 'authenticate',
    REQUEST_PERMISSION: 'session/request_permission',
    READ_TEXT_FILE: 'fs/read_text_file',
    WRITE_TEXT_FILE: 'fs/write_text_file'
};
export const ACP_ERROR_CODES = {
    PARSE_ERROR: -32700,
    INVALID_REQUEST: -32600,
    METHOD_NOT_FOUND: -32601,
    INVALID_PARAMS: -32602,
    INTERNAL_ERROR: -32603,
    AUTH_REQUIRED: -32000,
    RESOURCE_NOT_FOUND: -32002,
    REQUEST_CANCELLED: -32800
};
export function isJsonRpcRequest(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return false;
    const record = value;
    return record.jsonrpc === '2.0'
        && (typeof record.id === 'string' || typeof record.id === 'number')
        && typeof record.method === 'string';
}
export function isJsonRpcResponse(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return false;
    const record = value;
    return record.jsonrpc === '2.0'
        && (typeof record.id === 'string' || typeof record.id === 'number' || record.id === null)
        && ('result' in record || 'error' in record);
}
export function isJsonRpcNotification(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value))
        return false;
    const record = value;
    return record.jsonrpc === '2.0' && typeof record.method === 'string' && !('id' in record);
}
