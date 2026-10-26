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
    SET_CONFIG_OPTION: 'session/set_config_option',
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
/**
 * Extract live available models and active model ID from any ACP session/new,
 * session/load, session/set_config_option, or session/update payload.
 */
export function extractAcpSessionModels(payload) {
    const availableModels = [];
    const modelLabels = {};
    let currentModelId;
    let usesConfigOption = false;
    let configOptionId;
    if (!payload || typeof payload !== 'object') {
        return { availableModels, modelLabels, usesConfigOption };
    }
    const record = payload;
    const registerModel = (rawId, rawLabel) => {
        if (typeof rawId !== 'string')
            return;
        const id = rawId.trim();
        if (!id)
            return;
        if (!availableModels.includes(id)) {
            availableModels.push(id);
        }
        if (typeof rawLabel === 'string' && rawLabel.trim()) {
            modelLabels[id] = rawLabel.trim();
        }
    };
    // 1. Inspect ACP v1 configOptions (e.g. OpenCode, Claude Agent ACP, Codex ACP, Gemini ACP)
    const configOptions = Array.isArray(record.configOptions) ? record.configOptions : [];
    for (const rawOpt of configOptions) {
        if (!rawOpt || typeof rawOpt !== 'object')
            continue;
        const opt = rawOpt;
        const optId = typeof opt.id === 'string' ? opt.id.trim().toLowerCase() : '';
        const optCategory = typeof opt.category === 'string' ? opt.category.trim().toLowerCase() : '';
        if (optCategory !== 'model' && optId !== 'model' && optId !== 'models')
            continue;
        usesConfigOption = true;
        configOptionId = typeof opt.id === 'string' && opt.id.trim() ? opt.id.trim() : 'model';
        if (typeof opt.currentValue === 'string' && opt.currentValue.trim()) {
            currentModelId = opt.currentValue.trim();
        }
        const options = Array.isArray(opt.options) ? opt.options : [];
        for (const entry of options) {
            if (!entry || typeof entry !== 'object')
                continue;
            const entryObj = entry;
            if (Array.isArray(entryObj.options)) {
                for (const sub of entryObj.options) {
                    if (sub && typeof sub === 'object') {
                        const subObj = sub;
                        registerModel(subObj.value ?? subObj.modelId ?? subObj.id, subObj.name ?? subObj.label);
                    }
                }
            }
            else {
                registerModel(entryObj.value ?? entryObj.modelId ?? entryObj.id, entryObj.name ?? entryObj.label);
            }
        }
    }
    // 2. Inspect ACP models state ({ currentModelId, availableModels })
    const modelsField = record.models;
    if (modelsField && typeof modelsField === 'object' && !Array.isArray(modelsField)) {
        const modelsObj = modelsField;
        if (!currentModelId && typeof modelsObj.currentModelId === 'string' && modelsObj.currentModelId.trim()) {
            currentModelId = modelsObj.currentModelId.trim();
        }
        const list = Array.isArray(modelsObj.availableModels) ? modelsObj.availableModels : [];
        for (const item of list) {
            if (typeof item === 'string') {
                registerModel(item);
            }
            else if (item && typeof item === 'object') {
                const itemObj = item;
                registerModel(itemObj.modelId ?? itemObj.id ?? itemObj.value, itemObj.name ?? itemObj.label);
            }
        }
    }
    else if (Array.isArray(modelsField)) {
        for (const item of modelsField) {
            if (typeof item === 'string') {
                registerModel(item);
            }
            else if (item && typeof item === 'object') {
                const itemObj = item;
                registerModel(itemObj.modelId ?? itemObj.id ?? itemObj.value, itemObj.name ?? itemObj.label);
            }
        }
    }
    // 3. Inspect top-level availableModels / currentModelId if present
    if (!currentModelId && typeof record.currentModelId === 'string' && record.currentModelId.trim()) {
        currentModelId = record.currentModelId.trim();
    }
    if (Array.isArray(record.availableModels)) {
        for (const item of record.availableModels) {
            if (typeof item === 'string') {
                registerModel(item);
            }
            else if (item && typeof item === 'object') {
                const itemObj = item;
                registerModel(itemObj.modelId ?? itemObj.id ?? itemObj.value, itemObj.name ?? itemObj.label);
            }
        }
    }
    if (currentModelId && !availableModels.includes(currentModelId)) {
        availableModels.unshift(currentModelId);
    }
    return {
        currentModelId,
        availableModels,
        modelLabels,
        usesConfigOption,
        configOptionId
    };
}
