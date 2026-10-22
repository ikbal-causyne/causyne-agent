/**
 * Causyne Agent — Universal Tool Scanner & Compatibility Layer (toolsScan)
 *
 * Scans tool definitions for cross-vendor compatibility issues across LLM
 * providers (Gemini, Anthropic, OpenAI, DeepSeek, Ollama, Qwen, etc.) and
 * adapts them dynamically to each provider's wire format without degrading
 * or altering the tool's underlying functionality.
 */
const FREE_FORM_NOTE = ' Pass this as a JSON object encoded in a string, for example {"key":"value"}.';
const TOOL_NAME_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;
/**
 * Standardize tool name to match the wire grammar [a-zA-Z0-9_-]{1,64}.
 */
export function normalizeToolName(name) {
    return String(name || '').replace(/\./g, '_');
}
/**
 * Check if a schema node represents an empty object with no properties declared.
 */
export function isEmptyObjectSchema(schema) {
    if (!schema || typeof schema !== 'object')
        return false;
    const s = schema;
    return s['type'] === 'object' && (!s['properties'] || Object.keys(s['properties']).length === 0);
}
/**
 * Recursively inspect a schema for provider incompatibilities.
 */
function inspectSchemaForProvider(toolName, schema, path, provider, issues) {
    if (!schema || typeof schema !== 'object')
        return;
    const s = schema;
    const pathStr = path.join('.');
    if (s['type'] === 'array' && !s['items']) {
        issues.push({
            tool: toolName,
            path: pathStr,
            code: 'ARRAY_MISSING_ITEMS',
            message: `Array schema at '${pathStr}' lacks 'items' definition.`,
            severity: 'error'
        });
    }
    if (Array.isArray(s['type'])) {
        issues.push({
            tool: toolName,
            path: pathStr,
            code: 'UNION_TYPE_ARRAY',
            message: `Union type array [${s['type'].join(', ')}] at '${pathStr}' is unsupported by OpenAPI 3.0 / Gemini / DeepSeek.`,
            severity: 'warning'
        });
    }
    if (provider === 'gemini') {
        if ('additionalProperties' in s) {
            issues.push({
                tool: toolName,
                path: pathStr,
                code: 'GEMINI_ADDITIONAL_PROPERTIES',
                message: `'additionalProperties' at '${pathStr}' is forbidden in Gemini OpenAPI 3.0 subset.`,
                severity: 'error'
            });
        }
        if (s['type'] === 'object' && (!s['properties'] || Object.keys(s['properties']).length === 0)) {
            issues.push({
                tool: toolName,
                path: pathStr,
                code: 'GEMINI_EMPTY_OBJECT_SCHEMA',
                message: `Empty object schema at '${pathStr}' without declared properties is rejected by Gemini.`,
                severity: 'error'
            });
        }
        if ('$ref' in s || 'definitions' in s || 'patternProperties' in s) {
            issues.push({
                tool: toolName,
                path: pathStr,
                code: 'GEMINI_UNSUPPORTED_KEYWORDS',
                message: `Unsupported JSON Schema keyword at '${pathStr}' in Gemini.`,
                severity: 'warning'
            });
        }
    }
    if (s['properties'] && typeof s['properties'] === 'object') {
        for (const [propKey, propVal] of Object.entries(s['properties'])) {
            inspectSchemaForProvider(toolName, propVal, [...path, propKey], provider, issues);
        }
    }
    if (s['items'] && typeof s['items'] === 'object') {
        inspectSchemaForProvider(toolName, s['items'], [...path, '[]'], provider, issues);
    }
}
/**
 * Adapt a schema into Gemini's strict OpenAPI 3.0 subset without losing capability.
 * Free-form objects are converted to stringified JSON schemas and recorded.
 */
export function adaptSchemaForGemini(schema, path, rewritten) {
    if (Array.isArray(schema)) {
        return schema.map((entry) => adaptSchemaForGemini(entry, path, rewritten));
    }
    if (schema === null || typeof schema !== 'object') {
        return schema;
    }
    const s = schema;
    const adapted = {};
    for (const [key, value] of Object.entries(s)) {
        // 1. Strip additionalProperties (strictly rejected by Gemini)
        if (key === 'additionalProperties')
            continue;
        // 2. Strip unsupported keywords in Gemini OpenAPI
        if (key === '$ref' || key === 'definitions' || key === 'patternProperties')
            continue;
        // 3. Handle union types (e.g. type: ["string", "number"])
        if (key === 'type' && Array.isArray(value)) {
            const types = value;
            const safeType = types.find((t) => t !== 'null') || 'string';
            adapted['type'] = safeType;
            if (!adapted['description'] && s['description']) {
                adapted['description'] = `${s['description']} (accepts ${types.join(' or ')})`;
            }
            continue;
        }
        // 4. Handle nested properties
        if (key === 'properties' && value && typeof value === 'object') {
            const properties = {};
            for (const [name, child] of Object.entries(value)) {
                const childPath = [...path, name];
                if (isEmptyObjectSchema(child)) {
                    rewritten.push(childPath);
                    const childObj = (child && typeof child === 'object' ? child : {});
                    properties[name] = {
                        type: 'string',
                        description: (childObj['description'] || 'Free-form object.') + FREE_FORM_NOTE
                    };
                }
                else {
                    properties[name] = adaptSchemaForGemini(child, childPath, rewritten);
                }
            }
            adapted['properties'] = properties;
            continue;
        }
        // 5. Handle array items
        if (key === 'items') {
            adapted['items'] = adaptSchemaForGemini(value, [...path, '[]'], rewritten);
            continue;
        }
        adapted[key] = adaptSchemaForGemini(value, path, rewritten);
    }
    return adapted;
}
/**
 * Adapt a tool schema into Anthropic's Messages API format.
 */
export function adaptSchemaForAnthropic(toolObj, options = {}) {
    const rawParams = toolObj.parameters || toolObj.input_schema || {};
    let schema = typeof rawParams === 'object' && rawParams !== null ? { ...rawParams } : { type: 'object', properties: {} };
    if (schema.type !== 'object') {
        schema = { type: 'object', properties: {} };
    }
    if (!schema.properties) {
        schema.properties = {};
    }
    // Handle union types for clean typing
    const cleanSchema = cleanUnionTypes(schema);
    const declaration = {
        name: normalizeToolName(toolObj.name),
        description: toolObj.description || '',
        input_schema: cleanSchema
    };
    if (options.deferLoading) {
        declaration['defer_loading'] = true;
    }
    return declaration;
}
/**
 * Adapt a tool schema into OpenAI / OpenAI-Compatible (DeepSeek, XAI, Mistral, etc.) format.
 */
export function adaptSchemaForOpenAI(toolObj) {
    const rawParams = toolObj.parameters || toolObj.input_schema || {};
    let parameters = typeof rawParams === 'object' && rawParams !== null ? { ...rawParams } : { type: 'object', properties: {} };
    if (parameters.type !== 'object') {
        parameters = { type: 'object', properties: {} };
    }
    if (!parameters.properties) {
        parameters.properties = {};
    }
    const cleanParams = cleanUnionTypes(parameters);
    return {
        type: 'function',
        function: {
            name: normalizeToolName(toolObj.name),
            description: toolObj.description || '',
            parameters: cleanParams
        }
    };
}
/**
 * Adapt a tool schema into Ollama format (clean, straightforward parameters).
 */
export function adaptSchemaForOllama(toolObj) {
    return adaptSchemaForOpenAI(toolObj);
}
/**
 * Replaces union type arrays with single safe base types for providers that reject union types.
 */
function cleanUnionTypes(schema) {
    if (Array.isArray(schema)) {
        return schema.map(cleanUnionTypes);
    }
    if (!schema || typeof schema !== 'object') {
        return schema;
    }
    const s = { ...schema };
    if (Array.isArray(s['type'])) {
        const types = s['type'];
        s['type'] = types.find((t) => t !== 'null') || 'string';
        if (s['description']) {
            s['description'] = `${s['description']} (accepts ${types.join(' or ')})`;
        }
    }
    if (s['properties'] && typeof s['properties'] === 'object') {
        const props = {};
        for (const [k, v] of Object.entries(s['properties'])) {
            props[k] = cleanUnionTypes(v);
        }
        s['properties'] = props;
    }
    if (s['items']) {
        s['items'] = cleanUnionTypes(s['items']);
    }
    return s;
}
/**
 * Scans a set of tool definitions for compatibility with a specific provider,
 * and generates adapted definitions that are 100% compliant.
 */
export function scanAndAdaptToolsForProvider(tools, provider, options = {}) {
    const normProvider = provider.toLowerCase();
    const issues = [];
    const adaptedTools = [];
    const freeFormPaths = new Map();
    const isGemini = normProvider === 'gemini';
    const isAnthropic = normProvider === 'anthropic';
    const isOllama = normProvider === 'ollama';
    for (let index = 0; index < tools.length; index++) {
        const t = tools[index];
        if (!t)
            continue;
        const toolObj = (t.function ? t.function : t);
        const name = normalizeToolName(toolObj.name);
        if (!TOOL_NAME_REGEX.test(name)) {
            issues.push({
                tool: name,
                path: 'name',
                code: 'INVALID_TOOL_NAME',
                message: `Tool name "${name}" violates grammar ^[a-zA-Z0-9_-]{1,64}$`,
                severity: 'error'
            });
        }
        if (!toolObj.description) {
            issues.push({
                tool: name,
                path: 'description',
                code: 'MISSING_TOOL_DESCRIPTION',
                message: `Tool "${name}" is missing a description.`,
                severity: 'warning'
            });
        }
        const rawSchema = toolObj.parameters || toolObj.input_schema;
        inspectSchemaForProvider(name, rawSchema, ['parameters'], normProvider, issues);
        if (isGemini) {
            const declaration = {
                name,
                description: toolObj.description || ''
            };
            if (rawSchema && !isEmptyObjectSchema(rawSchema)) {
                const rewritten = [];
                declaration['parameters'] = adaptSchemaForGemini(rawSchema, [], rewritten);
                if (rewritten.length > 0) {
                    freeFormPaths.set(name, rewritten);
                }
            }
            adaptedTools.push(declaration);
        }
        else if (isAnthropic) {
            const deferLoading = Boolean(options.useToolSearch &&
                typeof options.coreToolCount === 'number' &&
                index >= options.coreToolCount);
            adaptedTools.push(adaptSchemaForAnthropic(toolObj, { deferLoading }));
        }
        else if (isOllama) {
            adaptedTools.push(adaptSchemaForOllama(toolObj));
        }
        else {
            // Default to OpenAI / OpenAI-Compatible (DeepSeek, XAI, Mistral, etc.)
            adaptedTools.push(adaptSchemaForOpenAI(toolObj));
        }
    }
    const incompatibleCount = issues.filter((i) => i.severity === 'error').length;
    return {
        provider: normProvider,
        totalTools: tools.length,
        compatibleTools: tools.length - incompatibleCount,
        incompatibleCount,
        issues,
        adaptedTools,
        freeFormPaths
    };
}
/**
 * Decode free-form arguments that were stringified for Gemini back into native objects.
 */
export function decodeFreeFormArguments(args, paths) {
    if (!args || !paths || paths.length === 0)
        return args;
    for (const path of paths) {
        applyAtPath(args, path, (value) => {
            if (typeof value !== 'string')
                return value;
            try {
                return JSON.parse(value);
            }
            catch {
                return value;
            }
        });
    }
    return args;
}
function applyAtPath(node, path, transform) {
    if (node === null || typeof node !== 'object')
        return;
    const target = node;
    const [head, ...rest] = path;
    if (!head)
        return;
    if (head === '[]') {
        if (!Array.isArray(node))
            return;
        for (const entry of node)
            applyAtPath(entry, rest, transform);
        return;
    }
    if (rest.length === 0) {
        if (head in target) {
            target[head] = transform(target[head]);
        }
        return;
    }
    applyAtPath(target[head], rest, transform);
}
