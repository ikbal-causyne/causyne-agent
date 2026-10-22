/**
 * Causyne Agent — Universal Tool Self-Repair & Healing Buffer (toolsSelfRepair)
 *
 * Intercepts, sanitizes, heals, and type-coerces LLM tool calls at runtime.
 * Automatically recovers from malformed JSON, unescaped newlines, trailing
 * commas, single quotes, parameter name hallucinations, and type mismatches
 * without degrading tool functionality or throwing unhandled errors.
 */
import path from 'node:path';
/**
 * Universal parameter alias dictionary mapping common LLM hallucinated
 * parameter names to their canonical schema counterparts.
 */
const PARAMETER_ALIASES = {
    path: [
        'filepath', 'file_path', 'filePath', 'targetFile', 'target_file',
        'fileName', 'file_name', 'file', 'target', 'dir', 'folder',
        'src_path', 'source_file', 'target_path'
    ],
    command: [
        'cmd', 'bash', 'sh', 'script', 'shell', 'exec',
        'terminalCommand', 'run', 'instruction'
    ],
    query: [
        'q', 'search', 'term', 'pattern', 'search_term',
        'searchQuery', 'find', 'prompt'
    ],
    content: [
        'contents', 'data', 'text', 'body', 'code', 'payload', 'input'
    ],
    destination: [
        'dest', 'to', 'targetPath', 'destPath', 'destination_path', 'target_path'
    ],
    source: [
        'src', 'from', 'sourcePath', 'source_path', 'source_file'
    ],
    action: [
        'act', 'operation', 'op', 'mode', 'method'
    ],
    message: [
        'msg', 'prompt', 'text', 'note'
    ],
    reason: [
        'why', 'justification', 'details', 'explanation'
    ],
    filter: [
        'pattern', 'glob', 'regex', 'matching'
    ],
    options: [
        'opts', 'config', 'settings', 'params'
    ],
    timeout: [
        'timeoutMs', 'timeout_ms', 'timeoutSec', 'duration'
    ]
};
/**
 * Attempt to repair and parse potentially malformed JSON argument strings.
 */
export function repairJsonArguments(rawInput) {
    const repairs = [];
    // 1. If already an object, return as-is
    if (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) {
        return {
            args: { ...rawInput },
            repaired: false,
            repairs: []
        };
    }
    if (typeof rawInput !== 'string') {
        return {
            args: {},
            repaired: false,
            repairs: []
        };
    }
    let text = rawInput.trim();
    if (text === '' || text === '{}') {
        return {
            args: {},
            repaired: false,
            repairs: []
        };
    }
    // 2. Fast path: native parse
    try {
        const parsed = JSON.parse(text);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return { args: parsed, repaired: false, repairs: [] };
        }
        if (Array.isArray(parsed)) {
            return { args: { items: parsed }, repaired: true, repairs: ['Wrapped array payload into items property'] };
        }
    }
    catch {
        // Proceed to healing pipeline
    }
    let healed = text;
    // 3. Strip Markdown code fences: ```json ... ``` or ``` ... ```
    if (healed.includes('```')) {
        const fenceMatch = healed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (fenceMatch && fenceMatch[1]) {
            healed = fenceMatch[1].trim();
            repairs.push('Stripped markdown code fence block');
        }
    }
    // 4. Extract first balanced JSON object if surrounded by conversational filler
    if (!healed.startsWith('{')) {
        const startIdx = healed.indexOf('{');
        const endIdx = healed.lastIndexOf('}');
        if (startIdx !== -1 && endIdx > startIdx) {
            healed = healed.slice(startIdx, endIdx + 1).trim();
            repairs.push('Extracted JSON object substring from conversational output');
        }
    }
    // 5. Native parse retry after stripping markdown/filler
    try {
        const parsed = JSON.parse(healed);
        if (parsed && typeof parsed === 'object') {
            return { args: parsed, repaired: true, repairs };
        }
    }
    catch {
        // Proceed to syntax healing
    }
    // 6. Fix unescaped control characters & newlines inside strings
    healed = sanitizeUnescapedStringLiterals(healed);
    // 7. Remove trailing commas before } or ]
    const trailingCommaFixed = healed.replace(/,\s*([}\]])/g, '$1');
    if (trailingCommaFixed !== healed) {
        healed = trailingCommaFixed;
        repairs.push('Removed trailing commas');
    }
    // 8. Convert single-quoted keys/values to double-quoted keys/values
    if (healed.includes("'")) {
        const doubleQuoted = convertSingleQuotesToJson(healed);
        if (doubleQuoted !== healed) {
            healed = doubleQuoted;
            repairs.push('Converted single quotes to valid JSON double quotes');
        }
    }
    // 9. Recover truncated JSON by balancing braces/brackets
    healed = balanceTruncatedJson(healed, repairs);
    // 10. Final parse attempt
    try {
        const parsed = JSON.parse(healed);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            return { args: parsed, repaired: true, repairs };
        }
        if (Array.isArray(parsed)) {
            return { args: { items: parsed }, repaired: true, repairs: [...repairs, 'Wrapped array payload into items'] };
        }
    }
    catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        return {
            args: {},
            repaired: false,
            repairs,
            error: `JSON parse recovery failed: ${errorMsg}`
        };
    }
    return { args: {}, repaired: false, repairs };
}
/**
 * Handle unescaped newlines/tabs inside string literals without breaking valid JSON escapes.
 */
function sanitizeUnescapedStringLiterals(input) {
    let result = '';
    let inString = false;
    let escapeNext = false;
    for (let i = 0; i < input.length; i++) {
        const char = input[i];
        if (escapeNext) {
            result += char;
            escapeNext = false;
            continue;
        }
        if (char === '\\') {
            escapeNext = true;
            result += char;
            continue;
        }
        if (char === '"') {
            inString = !inString;
            result += char;
            continue;
        }
        if (inString) {
            if (char === '\n') {
                result += '\\n';
                continue;
            }
            if (char === '\r') {
                result += '\\r';
                continue;
            }
            if (char === '\t') {
                result += '\\t';
                continue;
            }
        }
        result += char;
    }
    return result;
}
/**
 * Convert simple single-quoted JSON objects to valid double-quoted JSON.
 */
function convertSingleQuotesToJson(input) {
    return input.replace(/'([^'\\]*(?:\\.[^'\\]*)*)'/g, (_match, inner) => {
        // Escape internal unescaped double quotes inside the string
        const escaped = inner.replace(/"/g, '\\"');
        return `"${escaped}"`;
    });
}
/**
 * Balance unmatched brackets/braces if the LLM output was truncated.
 */
function balanceTruncatedJson(input, repairs) {
    let str = input.trim();
    const stack = [];
    let inString = false;
    let escapeNext = false;
    for (let i = 0; i < str.length; i++) {
        const char = str[i];
        if (escapeNext) {
            escapeNext = false;
            continue;
        }
        if (char === '\\') {
            escapeNext = true;
            continue;
        }
        if (char === '"') {
            inString = !inString;
            continue;
        }
        if (inString)
            continue;
        if (char === '{' || char === '[') {
            stack.push(char);
        }
        else if (char === '}') {
            if (stack.length > 0 && stack[stack.length - 1] === '{') {
                stack.pop();
            }
        }
        else if (char === ']') {
            if (stack.length > 0 && stack[stack.length - 1] === '[') {
                stack.pop();
            }
        }
    }
    // If a string was left open, close it
    if (inString) {
        str += '"';
        repairs.push('Closed unclosed string literal');
    }
    // Balance remaining open brackets/braces in reverse order
    if (stack.length > 0) {
        while (stack.length > 0) {
            const open = stack.pop();
            if (open === '{')
                str += '}';
            if (open === '[')
                str += ']';
        }
        repairs.push('Balanced unclosed braces/brackets on truncated JSON');
    }
    return str;
}
/**
 * Map hallucinated parameter aliases to the canonical parameter names expected by the tool schema.
 */
export function resolveParameterAliases(toolName, args, schema) {
    const repairs = [];
    const modified = { ...args };
    // Identify expected parameters from schema or default aliases
    const expectedKeys = new Set();
    if (schema && schema.properties) {
        for (const key of Object.keys(schema.properties)) {
            expectedKeys.add(key);
        }
    }
    for (const [canonicalParam, aliases] of Object.entries(PARAMETER_ALIASES)) {
        // If the schema specifies this tool takes canonicalParam (or no schema provided)
        const isExpected = expectedKeys.size === 0 || expectedKeys.has(canonicalParam);
        if (!isExpected)
            continue;
        // If canonicalParam is missing or undefined/null/empty
        if (modified[canonicalParam] === undefined || modified[canonicalParam] === null || modified[canonicalParam] === '') {
            for (const alias of aliases) {
                if (modified[alias] !== undefined && modified[alias] !== null && modified[alias] !== '') {
                    modified[canonicalParam] = modified[alias];
                    repairs.push(`Mapped hallucinated parameter alias '${alias}' -> '${canonicalParam}' for tool '${toolName}'`);
                    break;
                }
            }
        }
    }
    return {
        args: modified,
        repaired: repairs.length > 0,
        repairs
    };
}
/**
 * Automatically coerce argument types according to the tool's parameter schema.
 */
export function coerceArgumentTypes(toolName, args, schema) {
    const repairs = [];
    const modified = { ...args };
    if (!schema || !schema.properties) {
        return { args: modified, repaired: false, repairs: [] };
    }
    for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (!(key in modified))
            continue;
        const val = modified[key];
        const expectedType = propSchema.type;
        // 1. Number / Integer coercion
        if (expectedType === 'number' || expectedType === 'integer') {
            if (typeof val === 'string') {
                const trimmed = val.trim();
                if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
                    const num = expectedType === 'integer' ? parseInt(trimmed, 10) : parseFloat(trimmed);
                    if (!isNaN(num)) {
                        modified[key] = num;
                        repairs.push(`Coerced string "${val}" -> number ${num} for parameter '${key}'`);
                    }
                }
            }
        }
        // 2. Boolean coercion
        if (expectedType === 'boolean') {
            if (typeof val === 'string') {
                const lower = val.trim().toLowerCase();
                if (lower === 'true' || lower === '1') {
                    modified[key] = true;
                    repairs.push(`Coerced string "${val}" -> boolean true for parameter '${key}'`);
                }
                else if (lower === 'false' || lower === '0') {
                    modified[key] = false;
                    repairs.push(`Coerced string "${val}" -> boolean false for parameter '${key}'`);
                }
            }
            else if (typeof val === 'number') {
                modified[key] = val !== 0;
                repairs.push(`Coerced number ${val} -> boolean ${modified[key]} for parameter '${key}'`);
            }
        }
        // 3. Array coercion
        if (expectedType === 'array') {
            if (typeof val === 'string') {
                const trimmed = val.trim();
                if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
                    try {
                        const parsed = JSON.parse(trimmed);
                        if (Array.isArray(parsed)) {
                            modified[key] = parsed;
                            repairs.push(`Parsed stringified array for parameter '${key}'`);
                        }
                    }
                    catch {
                        // Passthrough
                    }
                }
                else if (trimmed.includes(',')) {
                    modified[key] = trimmed.split(',').map((s) => s.trim());
                    repairs.push(`Split comma-separated string into array for parameter '${key}'`);
                }
            }
        }
        // 4. Object coercion
        if (expectedType === 'object') {
            if (typeof val === 'string') {
                const trimmed = val.trim();
                if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
                    try {
                        const parsed = JSON.parse(trimmed);
                        if (parsed && typeof parsed === 'object') {
                            modified[key] = parsed;
                            repairs.push(`Parsed stringified JSON object for parameter '${key}'`);
                        }
                    }
                    catch {
                        // Passthrough
                    }
                }
            }
        }
    }
    return {
        args: modified,
        repaired: repairs.length > 0,
        repairs
    };
}
/**
 * Automatically normalize relative file paths to absolute paths using cwd.
 */
export function normalizePaths(args, cwd = process.cwd()) {
    const repairs = [];
    const modified = { ...args };
    const pathKeys = ['path', 'source', 'destination', 'targetFile'];
    for (const key of pathKeys) {
        const val = modified[key];
        if (typeof val === 'string' && val.trim() !== '') {
            const trimmed = val.trim();
            if (!path.isAbsolute(trimmed) && !trimmed.startsWith('~')) {
                modified[key] = path.resolve(cwd, trimmed);
                repairs.push(`Normalized relative path '${trimmed}' -> '${modified[key]}' for parameter '${key}'`);
            }
        }
    }
    return {
        args: modified,
        repaired: repairs.length > 0,
        repairs
    };
}
/**
 * Master self-repair entrypoint: heals raw tool call JSON, resolves aliases,
 * coerces argument types, and normalizes paths.
 */
export function selfRepairToolCall(toolCall, toolSchema, options = {}) {
    const rawName = toolCall.function?.name || toolCall.name || '';
    const rawArgs = toolCall.function?.arguments !== undefined
        ? toolCall.function.arguments
        : toolCall.arguments;
    const allRepairs = [];
    // 1. Repair JSON parsing
    const jsonResult = repairJsonArguments(rawArgs);
    if (jsonResult.error) {
        return {
            name: rawName,
            args: {},
            repaired: false,
            repairs: jsonResult.repairs,
            error: jsonResult.error
        };
    }
    allRepairs.push(...jsonResult.repairs);
    // 2. Resolve parameter aliases
    const aliasResult = resolveParameterAliases(rawName, jsonResult.args, toolSchema);
    allRepairs.push(...aliasResult.repairs);
    // 3. Coerce argument types
    const typeResult = coerceArgumentTypes(rawName, aliasResult.args, toolSchema);
    allRepairs.push(...typeResult.repairs);
    // 4. Normalize filesystem paths
    const pathResult = normalizePaths(typeResult.args, options.cwd || process.cwd());
    allRepairs.push(...pathResult.repairs);
    return {
        name: rawName,
        args: pathResult.args,
        repaired: allRepairs.length > 0,
        repairs: allRepairs
    };
}
/**
 * Generate a rich, non-crashing self-repair diagnostic message for the agent loop
 * when required tool parameters are missing and cannot be automatically inferred.
 */
export function generateSelfRepairDiagnostic(toolName, args, errorMessage, schema) {
    const required = schema?.required || [];
    const properties = schema?.properties || {};
    const expectedFields = {};
    for (const req of required) {
        const prop = properties[req];
        expectedFields[req] = prop?.description || (typeof prop?.type === 'string' ? prop.type : 'required');
    }
    return {
        success: false,
        error: `Validation error for tool '${toolName}': ${errorMessage}`,
        selfRepairGuidance: {
            tool: toolName,
            missingOrInvalid: errorMessage,
            expectedParameters: expectedFields,
            receivedArguments: args,
            instruction: `Please re-invoke '${toolName}' supplying the valid required parameters.`
        }
    };
}
