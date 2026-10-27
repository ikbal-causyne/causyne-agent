/**
 * Causyne Agent — Universal Tool Self-Repair & Healing Buffer (toolsSelfRepair)
 *
 * Intercepts, sanitizes, heals, and type-coerces LLM tool calls at runtime.
 * Automatically recovers from malformed JSON, unescaped newlines, trailing
 * commas, single quotes, parameter name hallucinations, and type mismatches
 * without degrading tool functionality or throwing unhandled errors.
 */
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
/**
 * Universal tool name alias dictionary. Maps hallucinations from OpenAI,
 * Anthropic, DeepSeek, Qwen, Ollama, etc. to Causyne Agent canonical tool names.
 */
export const TOOL_NAME_ALIASES = {
    // Core filesystem
    read_file: 'fs_read',
    readFile: 'fs_read',
    view_file: 'fs_read',
    cat: 'fs_read',
    write_file: 'fs_write',
    writeFile: 'fs_write',
    write_to_file: 'fs_write',
    create_file: 'fs_write',
    edit_file: 'fs_edit',
    editFile: 'fs_edit',
    replace_file_content: 'fs_edit',
    modify_file: 'fs_edit',
    delete_file: 'fs_delete',
    deleteFile: 'fs_delete',
    remove_file: 'fs_delete',
    rm: 'fs_delete',
    list_dir: 'fs_list',
    listDir: 'fs_list',
    list_files: 'fs_list',
    listFiles: 'fs_list',
    list_directory: 'fs_list',
    ls: 'fs_list',
    find_files: 'fs_find',
    findFiles: 'fs_find',
    find_file: 'fs_find',
    glob: 'fs_find',
    search_files: 'fs_search',
    grep: 'fs_search',
    grep_search: 'fs_search',
    move_file: 'fs_move',
    moveFile: 'fs_move',
    rename_file: 'fs_move',
    mv: 'fs_move',
    patch: 'MultiEdit',
    multi_edit: 'MultiEdit',
    multiedit: 'MultiEdit',
    diff_edit: 'MultiEdit',
    // Execution & shell
    sys_run: 'sysRun',
    sysrun: 'sysRun',
    run_command: 'sysRun',
    runCommand: 'sysRun',
    bash: 'sysRun',
    sh: 'sysRun',
    terminal: 'sysRun',
    exec_command: 'sysRun',
    execute_command: 'sysRun',
    shell: 'sysRun',
    sys_run_bg: 'sysRunBg',
    sysrunbg: 'sysRunBg',
    sysRun_bg: 'sysRunBg',
    run_bg: 'sysRunBg',
    run_background: 'sysRunBg',
    background_run: 'sysRunBg',
    git_op: 'gitOp',
    gitop: 'gitOp',
    git: 'gitOp',
    gitExec: 'gitOp',
    procTerm: 'proc_term',
    persistent_shell: 'terminal_persistent_shell',
    terminal_shell: 'terminal_persistent_shell',
    // Web & search
    search_web: 'web_search',
    searchWeb: 'web_search',
    google_search: 'web_search',
    search_internet: 'web_search',
    fetch_url: 'web_fetch',
    fetchUrl: 'web_fetch',
    read_url: 'web_fetch',
    read_url_content: 'web_fetch',
    http_get: 'web_fetch',
    browserAutomator: 'browser_act',
    browser_automator: 'browser_act',
    browser: 'browser_act',
    causyne_browser: 'browser_act',
    camofox: 'browser_act',
    camoufox: 'browser_act',
    // Specialized engines & capabilities
    nativeEngine: 'native_engine',
    'native-engine': 'native_engine',
    creativeApps: 'creative_apps',
    'creative-apps': 'creative_apps',
    astryxOracle: 'astryx_oracle',
    pdfRead: 'pdf_read',
    codeVerifySyntax: 'code_verify_syntax',
    codeListSymbols: 'code_list_symbols',
    codeSearchAst: 'code_search_ast',
    codeSearcher: 'code_search_ripgrep',
    blenderAutomator: 'blender_act',
    blender_automator: 'blender_act',
    blender: 'blender_act',
    blender_act: 'blender_act',
    blender_batch: 'blender_act',
    blender_render: 'blender_act',
    blenderAct: 'blender_act',
    render_3d: 'blender_act',
    viewImage: 'view_image',
    view_image: 'view_image',
    show_image: 'view_image',
    inspect_image: 'view_image',
    open_image: 'view_image',
    resolveAutomator: 'resolve_act',
    palmierAutomator: 'palmier_act',
    godotAutomator: 'godot_act',
    visionInspector: 'vision_inspect_ui',
    vision_inspector: 'vision_inspect_ui',
    vision_inspect: 'vision_inspect_ui',
    computerUse: 'computer_use',
    uiForge: 'ui_forge',
    documentForge: 'document_forge',
    documentForgeTool: 'document_forge',
    peerAgent: 'peer_agent_delegate',
    peer_agent: 'peer_agent_delegate',
    openSourceToolProvisioner: 'open_source_tool_provisioner',
    open_source_tool: 'open_source_tool_provisioner',
    subagent: 'agent_subagent_orchestrate',
    subagent_orchestrator: 'agent_subagent_orchestrate',
    spawn_subagent: 'agent_subagent_orchestrate',
    agent_orchestrator: 'agent_subagent_orchestrate',
    printer_status: 'printer_get_status',
    printer_list: 'printer_list_printers',
    create_skill: 'skill_create',
    read_skill: 'fs_read_skill',
    readNativeSkill: 'fs_read_skill',
    take_screenshot: 'screenshot',
    capture_screenshot: 'screenshot',
    open_file: 'desktop_open',
    open_desktop: 'desktop_open',
    TodoWrite: 'update_plan',
    manage_local_ai_dependencies: 'manage_local_dependencies',
    tool_deferred_mcp_search: 'tool_search'
};
function stripDelimiters(str) {
    return String(str || '').toLowerCase().replace(/[-_.]/g, '');
}
const DELIMITER_FREE_TOOL_INDEX = {};
for (const [alias, canonical] of Object.entries(TOOL_NAME_ALIASES)) {
    DELIMITER_FREE_TOOL_INDEX[stripDelimiters(alias)] = canonical;
    DELIMITER_FREE_TOOL_INDEX[stripDelimiters(canonical)] = canonical;
}
/**
 * Resolve any raw tool name (including hallucinated or camelCased names) to its canonical tool name.
 */
export function canonicalizeToolName(rawName) {
    const normalized = String(rawName || '').replace(/\./g, '_');
    if (TOOL_NAME_ALIASES[normalized]) {
        return TOOL_NAME_ALIASES[normalized];
    }
    const stripped = stripDelimiters(rawName);
    if (DELIMITER_FREE_TOOL_INDEX[stripped]) {
        return DELIMITER_FREE_TOOL_INDEX[stripped];
    }
    return normalized;
}
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
    file_path: [
        'path', 'filepath', 'filePath', 'targetFile', 'target_file',
        'fileName', 'file_name', 'file', 'target'
    ],
    command: [
        'cmd', 'bash', 'sh', 'script', 'shell', 'exec',
        'terminalCommand', 'run', 'instruction'
    ],
    query: [
        'q', 'search', 'term', 'pattern', 'search_term',
        'searchQuery', 'find', 'prompt'
    ],
    pattern: [
        'query', 'q', 'search', 'regex', 'term', 'filter'
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
    ],
    url: [
        'link', 'href', 'endpoint', 'uri', 'target_url'
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
 * Map hallucinated parameter aliases to the canonical parameter names expected by the tool schema,
 * with deep structural healing for complex tools (fs_edit, MultiEdit, native_engine, creative_apps).
 */
export function resolveParameterAliases(toolName, args, schema) {
    const repairs = [];
    const modified = { ...args };
    const canonicalName = canonicalizeToolName(toolName);
    // 1. Specialized structural healing: fs_edit vs MultiEdit
    if (canonicalName === 'fs_edit') {
        // If edits is missing, synthesize from top-level fields
        if (!modified.edits && (modified.searchContent || modified.old_string || modified.oldText || modified.find)) {
            const search = (modified.searchContent || modified.old_string || modified.oldText || modified.find || '');
            const replace = (modified.replaceContent || modified.new_string || modified.newText || modified.replacement || '');
            modified.edits = [{ searchContent: search, replaceContent: replace }];
            delete modified.searchContent;
            delete modified.old_string;
            delete modified.oldText;
            delete modified.find;
            delete modified.replaceContent;
            delete modified.new_string;
            delete modified.newText;
            delete modified.replacement;
            repairs.push("Synthesized 'edits' array from top-level edit parameters for 'fs_edit'");
        }
        else if (Array.isArray(modified.edits)) {
            modified.edits = modified.edits.map((item) => {
                if (!item || typeof item !== 'object')
                    return item;
                const normalizedItem = { ...item };
                if (!normalizedItem.searchContent && (normalizedItem.old_string || normalizedItem.oldText || normalizedItem.find)) {
                    normalizedItem.searchContent = normalizedItem.old_string || normalizedItem.oldText || normalizedItem.find;
                }
                if (!normalizedItem.replaceContent && (normalizedItem.new_string || normalizedItem.newText || normalizedItem.replace)) {
                    normalizedItem.replaceContent = normalizedItem.new_string || normalizedItem.newText || normalizedItem.replace;
                }
                return normalizedItem;
            });
        }
    }
    else if (canonicalName === 'MultiEdit') {
        if (!modified.edits && (modified.old_string || modified.searchContent || modified.oldText || modified.find)) {
            const search = (modified.old_string || modified.searchContent || modified.oldText || modified.find || '');
            const replace = (modified.new_string || modified.replaceContent || modified.newText || modified.replacement || '');
            modified.edits = [{ old_string: search, new_string: replace }];
            delete modified.searchContent;
            delete modified.old_string;
            delete modified.oldText;
            delete modified.find;
            delete modified.replaceContent;
            delete modified.new_string;
            delete modified.newText;
            delete modified.replacement;
            repairs.push("Synthesized 'edits' array from top-level edit parameters for 'MultiEdit'");
        }
        else if (Array.isArray(modified.edits)) {
            modified.edits = modified.edits.map((item) => {
                if (!item || typeof item !== 'object')
                    return item;
                const normalizedItem = { ...item };
                if (!normalizedItem.old_string && (normalizedItem.searchContent || normalizedItem.oldText || normalizedItem.find)) {
                    normalizedItem.old_string = normalizedItem.searchContent || normalizedItem.oldText || normalizedItem.find;
                }
                if (!normalizedItem.new_string && (normalizedItem.replaceContent || normalizedItem.newText || normalizedItem.replace)) {
                    normalizedItem.new_string = normalizedItem.replaceContent || normalizedItem.newText || normalizedItem.replace;
                }
                return normalizedItem;
            });
        }
    }
    else if (canonicalName === 'native_engine') {
        if (Array.isArray(modified.steps)) {
            modified.steps = modified.steps.map((item) => {
                if (!item || typeof item !== 'object')
                    return item;
                const norm = { ...item };
                if (!norm.id && (norm.name || norm.action || norm.command || norm.task)) {
                    norm.id = norm.name || norm.action || norm.command || norm.task;
                }
                if (!norm.params && (norm.args || norm.arguments || norm.options || norm.data)) {
                    norm.params = norm.args || norm.arguments || norm.options || norm.data;
                }
                return norm;
            });
        }
    }
    else if (canonicalName === 'creative_apps') {
        if (Array.isArray(modified.actions)) {
            modified.actions = modified.actions.map((item) => {
                if (!item || typeof item !== 'object')
                    return item;
                const norm = { ...item };
                if (!norm.action && (norm.command || norm.name || norm.operation)) {
                    norm.action = norm.command || norm.name || norm.operation;
                }
                if (!norm.parameters && (norm.params || norm.args || norm.arguments)) {
                    norm.parameters = norm.params || norm.args || norm.arguments;
                }
                return norm;
            });
        }
    }
    else if (canonicalName === 'browser_act') {
        if (!modified.actions) {
            if (Array.isArray(modified.steps) || Array.isArray(modified.items)) {
                modified.actions = modified.steps || modified.items;
                delete modified.steps;
                delete modified.items;
                repairs.push("Mapped 'steps'/'items' to 'actions' parameter for 'browser_act'");
            }
            else if (typeof modified.type === 'string' || typeof modified.action === 'string') {
                const singleAction = { ...modified };
                if (!singleAction.type && typeof singleAction.action === 'string') {
                    singleAction.type = singleAction.action;
                    delete singleAction.action;
                }
                for (const key of Object.keys(modified)) {
                    delete modified[key];
                }
                modified.actions = [singleAction];
                repairs.push("Wrapped single top-level browser action into 'actions' array for 'browser_act'");
            }
        }
        if (Array.isArray(modified.actions)) {
            modified.actions = modified.actions.map((item) => {
                if (!item || typeof item !== 'object')
                    return item;
                const norm = { ...item };
                if (!norm.type && typeof norm.action === 'string') {
                    norm.type = norm.action;
                    delete norm.action;
                }
                if (!norm.ref && typeof (norm.elementRef || norm.element) === 'string') {
                    norm.ref = norm.elementRef || norm.element;
                    delete norm.elementRef;
                    delete norm.element;
                }
                if ((norm.type === 'download' || norm.type === 'screenshot') && !norm.outputFile && typeof (norm.path || norm.file) === 'string') {
                    norm.outputFile = norm.path || norm.file;
                    delete norm.path;
                    delete norm.file;
                }
                if (norm.type === 'upload' && !norm.filePath && (norm.path || norm.file || norm.files)) {
                    norm.filePath = norm.path || norm.file || norm.files;
                    delete norm.path;
                    delete norm.file;
                    delete norm.files;
                }
                return norm;
            });
        }
    }
    else if (canonicalName === 'update_plan') {
        if (!modified.plan && (modified.steps || modified.items || modified.tasks)) {
            modified.plan = modified.steps || modified.items || modified.tasks;
            delete modified.steps;
            delete modified.items;
            delete modified.tasks;
            repairs.push("Mapped 'steps' to 'plan' parameter for 'update_plan'");
        }
        if (Array.isArray(modified.plan)) {
            let activeCount = 0;
            modified.plan = modified.plan.map((raw, idx) => {
                if (!raw || typeof raw !== 'object')
                    return raw;
                const item = { ...raw };
                if (!item.id)
                    item.id = `step-${idx + 1}`;
                if (!item.step && (item.content || item.title || item.name || item.description)) {
                    item.step = item.content || item.title || item.name || item.description;
                }
                let status = String(item.status || item.state || 'pending').toLowerCase().trim();
                if (status === 'in-progress' || status === 'in progress' || status === 'running' || status === 'working') {
                    status = 'in_progress';
                }
                else if (status === 'done' || status === 'finished' || status === 'complete') {
                    status = 'completed';
                }
                else if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') {
                    status = 'pending';
                }
                if (status === 'in_progress') {
                    activeCount++;
                    if (activeCount > 1) {
                        status = 'pending';
                        repairs.push(`Normalized extra in_progress step '${item.id}' to pending`);
                    }
                }
                item.status = status;
                return item;
            });
            repairs.push("Auto-healed and normalized plan steps for 'update_plan'");
        }
    }
    // 2. Identify expected parameters from schema or default aliases
    const expectedKeys = new Set();
    if (schema && schema.properties) {
        for (const key of Object.keys(schema.properties)) {
            expectedKeys.add(key);
        }
    }
    // 3. Resolve top-level parameter aliases
    for (const [canonicalParam, aliases] of Object.entries(PARAMETER_ALIASES)) {
        const isExpected = expectedKeys.size === 0 || expectedKeys.has(canonicalParam);
        if (!isExpected)
            continue;
        if (modified[canonicalParam] === undefined || modified[canonicalParam] === null || modified[canonicalParam] === '') {
            for (const alias of aliases) {
                if (modified[alias] !== undefined && modified[alias] !== null && modified[alias] !== '') {
                    modified[canonicalParam] = modified[alias];
                    repairs.push(`Mapped hallucinated parameter alias '${alias}' -> '${canonicalParam}' for tool '${canonicalName}'`);
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
            else if (Array.isArray(val) && val.length === 1) {
                const item = val[0];
                if (typeof item === 'number') {
                    modified[key] = item;
                    repairs.push(`Unwrapped single-element array to number for parameter '${key}'`);
                }
                else if (typeof item === 'string' && /^-?\d+(\.\d+)?$/.test(item.trim())) {
                    modified[key] = expectedType === 'integer' ? parseInt(item.trim(), 10) : parseFloat(item.trim());
                    repairs.push(`Unwrapped single-element array to number for parameter '${key}'`);
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
        // 3. Array coercion (auto-wraps single objects and parses strings)
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
                else if (trimmed.length > 0) {
                    modified[key] = [trimmed];
                    repairs.push(`Wrapped single string into array for parameter '${key}'`);
                }
            }
            else if (val && typeof val === 'object' && !Array.isArray(val)) {
                modified[key] = [val];
                repairs.push(`Wrapped single object into array for parameter '${key}'`);
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
        // 5. String coercion (unwrapping single-element arrays)
        if (expectedType === 'string') {
            if (Array.isArray(val) && val.length === 1 && typeof val[0] === 'string') {
                modified[key] = val[0];
                repairs.push(`Unwrapped single-element array to string for parameter '${key}'`);
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
    const pathKeys = ['path', 'file_path', 'source', 'destination', 'targetFile', 'target'];
    for (const key of pathKeys) {
        const val = modified[key];
        if (typeof val === 'string' && val.trim() !== '') {
            const trimmed = val.trim();
            // Skip URLs
            if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) {
                continue;
            }
            if (trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
                modified[key] = trimmed.replace(/^~(?=$|[\\/])/, os.homedir());
                repairs.push(`Expanded home directory path '${trimmed}' -> '${modified[key]}' for parameter '${key}'`);
            }
            else if (!path.isAbsolute(trimmed)) {
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
function repairBrowserActions(args, cwd) {
    const repairs = [];
    let workspace;
    try {
        workspace = fs.realpathSync.native(cwd);
    }
    catch {
        return { args, repaired: false, repairs };
    }
    const repairAction = (value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value))
            return value;
        const action = { ...value };
        const actionType = typeof action.type === 'string' ? 'type' : 'action';
        if ((action[actionType] === 'goto' || action[actionType] === 'navigate' || action[actionType] === 'open')
            && typeof action.url === 'string' && action.url.startsWith('file:')) {
            try {
                const target = fs.realpathSync.native(fileURLToPath(action.url));
                const relative = path.relative(workspace, target);
                if (relative && !relative.startsWith(`..${path.sep}`) && relative !== '..'
                    && !path.isAbsolute(relative) && /\.html?$/i.test(target)) {
                    action[actionType] = 'preview';
                    action.filePath = relative;
                    delete action.url;
                    repairs.push('Converted workspace HTML file navigation to browser preview');
                }
            }
            catch {
                // Leave malformed or out-of-scope URLs for the browser sandbox to reject.
            }
        }
        if (action[actionType] === 'screenshot' && !action.outputFile) {
            action.outputFile = `browser-capture-${randomUUID()}.png`;
            repairs.push('Added a unique workspace screenshot destination');
        }
        return action;
    };
    const updated = Array.isArray(args.actions)
        ? { ...args, actions: args.actions.map(repairAction) }
        : repairAction(args);
    return { args: updated, repaired: repairs.length > 0, repairs };
}
/**
 * Master self-repair entrypoint: heals raw tool call JSON, canonicalizes tool names,
 * resolves aliases, coerces argument types, and normalizes paths.
 */
export function selfRepairToolCall(toolCall, toolSchema, options = {}) {
    const rawName = toolCall.function?.name || toolCall.name || '';
    const canonicalName = canonicalizeToolName(rawName);
    const rawArgs = toolCall.function?.arguments !== undefined
        ? toolCall.function.arguments
        : toolCall.arguments;
    const allRepairs = [];
    if (canonicalName !== rawName) {
        allRepairs.push(`Canonicalized tool name '${rawName}' -> '${canonicalName}'`);
    }
    // 1. Repair JSON parsing
    const jsonResult = repairJsonArguments(rawArgs);
    if (jsonResult.error) {
        return {
            name: canonicalName,
            args: {},
            repaired: false,
            repairs: [...allRepairs, ...jsonResult.repairs],
            error: jsonResult.error
        };
    }
    allRepairs.push(...jsonResult.repairs);
    // 2. Resolve parameter aliases & structural transforms
    const aliasResult = resolveParameterAliases(canonicalName, jsonResult.args, toolSchema);
    allRepairs.push(...aliasResult.repairs);
    // 3. Coerce argument types
    const typeResult = coerceArgumentTypes(canonicalName, aliasResult.args, toolSchema);
    allRepairs.push(...typeResult.repairs);
    // 4. Normalize filesystem paths
    const pathResult = normalizePaths(typeResult.args, options.cwd || process.cwd());
    allRepairs.push(...pathResult.repairs);
    const browserResult = canonicalName === 'browser_act'
        ? repairBrowserActions(pathResult.args, options.cwd || process.cwd())
        : pathResult;
    if (canonicalName === 'browser_act')
        allRepairs.push(...browserResult.repairs);
    return {
        name: canonicalName,
        args: browserResult.args,
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
