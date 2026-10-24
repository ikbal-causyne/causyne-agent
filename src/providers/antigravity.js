import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { LLMProvider } from './base.js';
/**
 * Baseline fallback models for instant offline availability.
 * Live models are autodetected dynamically from `agy models`
 * and cached in ~/.causyne/models_cache.json.
 */
export const BASELINE_ANTIGRAVITY_MODELS = {
    'Gemini 3.8 Flash (Low)': 'gemini-3.8-flash-low',
    'Gemini 3.8 Flash (Medium)': 'gemini-3.8-flash-medium',
    'Gemini 3.8 Flash (High)': 'gemini-3.8-flash-high',
    'Gemini 4 Argon (Low)': 'gemini-4-argon-low',
    'Gemini 4 Argon (Medium)': 'gemini-4-argon-medium',
    'Gemini 4 Argon (High)': 'gemini-4-argon-high',
    'Claude Sonnet 5.5 (Low)': 'claude-sonnet-5-5-low',
    'Claude Sonnet 5.5 (Medium)': 'claude-sonnet-5-5-medium',
    'Claude Sonnet 5.5 (High)': 'claude-sonnet-5-5-high',
    'Claude Opus 5.5 (Low)': 'claude-opus-5-5-low',
    'Claude Opus 5.5 (Medium)': 'claude-opus-5-5-medium',
    'Claude Opus 5.5 (High)': 'claude-opus-5-5-high',
    'GPT-OSS 120B (Medium)': 'gpt-oss-120b-medium'
};
export const ANTIGRAVITY_MODEL_IDS = {
    ...BASELINE_ANTIGRAVITY_MODELS
};
export const ANTIGRAVITY_LABEL_BY_ID = Object.fromEntries(Object.entries(ANTIGRAVITY_MODEL_IDS).map(([label, id]) => [id, label]));
export const ANTIGRAVITY_MODELS = Object.keys(ANTIGRAVITY_MODEL_IDS);
export function registerAntigravityModel(slug, label) {
    if (!slug || typeof slug !== 'string')
        return;
    const cleanSlug = slug.trim();
    const cleanLabel = (label && typeof label === 'string' && label.trim()) || cleanSlug;
    ANTIGRAVITY_MODEL_IDS[cleanLabel] = cleanSlug;
    ANTIGRAVITY_MODEL_IDS[cleanSlug] = cleanSlug;
    ANTIGRAVITY_LABEL_BY_ID[cleanSlug] = cleanLabel;
    if (!ANTIGRAVITY_MODELS.includes(cleanLabel)) {
        ANTIGRAVITY_MODELS.push(cleanLabel);
    }
}
export function parseAgyModelsOutput(stdout) {
    const result = [];
    if (!stdout || typeof stdout !== 'string')
        return result;
    const lines = stdout.replace(/\r/g, '\n').split(/\n+/);
    for (const rawLine of lines) {
        const line = rawLine.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').trim();
        if (!line)
            continue;
        if (/^(fetching|loading|no models|error)/i.test(line))
            continue;
        if (line.endsWith('…') || line.endsWith('...'))
            continue;
        const cleanLine = line.replace(/^[^a-zA-Z0-9_-]+/, '');
        const match = cleanLine.match(/^([a-z0-9_.-]+)(?:\s+(.+))?$/i);
        if (!match)
            continue;
        const id = match[1].trim();
        const label = (match[2] && match[2].trim()) || id;
        result.push({ id, label });
        registerAntigravityModel(id, label);
    }
    return result;
}
function hydrateModelsFromDiskCache() {
    try {
        const home = process.env.HOME || process.env.USERPROFILE || '';
        const cacheFile = path.join(home, '.causyne', 'models_cache.json');
        if (!fs.existsSync(cacheFile))
            return;
        const content = fs.readFileSync(cacheFile, 'utf8');
        const parsed = JSON.parse(content);
        const agyModels = parsed?.providers?.antigravity?.models;
        if (Array.isArray(agyModels)) {
            for (const item of agyModels) {
                if (typeof item === 'string' && item.trim()) {
                    const trimmed = item.trim();
                    if (!ANTIGRAVITY_MODEL_IDS[trimmed]) {
                        registerAntigravityModel(trimmed, trimmed);
                    }
                }
            }
        }
    }
    catch {
        // Ignore cache read errors
    }
}
hydrateModelsFromDiskCache();
export function resolveAgyModelId(model) {
    if (typeof model !== 'string')
        return '';
    const trimmed = model.trim();
    if (!trimmed)
        return '';
    if (ANTIGRAVITY_MODEL_IDS[trimmed]) {
        return ANTIGRAVITY_MODEL_IDS[trimmed];
    }
    const lower = trimmed.toLowerCase();
    for (const [key, slug] of Object.entries(ANTIGRAVITY_MODEL_IDS)) {
        if (key.toLowerCase() === lower || slug.toLowerCase() === lower) {
            return slug;
        }
    }
    const effort = resolveAgyEffort(trimmed);
    const candidateWithEffort = `${lower}-${effort}`;
    for (const [key, slug] of Object.entries(ANTIGRAVITY_MODEL_IDS)) {
        if (slug.toLowerCase() === candidateWithEffort || key.toLowerCase() === candidateWithEffort) {
            return slug;
        }
    }
    for (const [key, slug] of Object.entries(ANTIGRAVITY_MODEL_IDS)) {
        if (slug.toLowerCase().startsWith(lower) || key.toLowerCase().startsWith(lower)) {
            return slug;
        }
    }
    return trimmed;
}
export function resolveAgyEffort(model) {
    if (typeof model !== 'string')
        return 'low';
    const m = model.toLowerCase();
    if (m.includes('(low)') || m.includes('-low'))
        return 'low';
    if (m.includes('(medium)') || m.includes('-medium'))
        return 'medium';
    if (m.includes('(high)') || m.includes('-high'))
        return 'high';
    if (m.includes('(xhigh)') || m.includes('-xhigh'))
        return 'xhigh';
    if (m.includes('(max)') || m.includes('-max'))
        return 'max';
    return 'low';
}
export function isAntigravityProvider(provider) {
    if (!provider)
        return false;
    const p = String(provider).toLowerCase();
    return p === 'antigravity' || p === 'agy' || p.startsWith('antigravity/') || p.startsWith('agy/');
}
export function resolveAgyBinary() {
    const envPath = process.env.PATH || '';
    const searchDirs = [
        ...envPath.split(path.delimiter),
        path.join(process.env.HOME || '', '.local/bin'),
        path.join(process.env.HOME || '', '.antigravity/antigravity/bin'),
        path.join(process.env.HOME || '', '.gemini/antigravity-ide/bin'),
        '/Applications/Antigravity.app/Contents/Resources/app/bin',
        '/Applications/Antigravity IDE.app/Contents/Resources/app/bin'
    ];
    const binNames = ['agy', 'antigravity'];
    for (const dir of searchDirs) {
        if (!dir)
            continue;
        for (const name of binNames) {
            const full = path.join(dir, name);
            try {
                if (fs.existsSync(full) && fs.statSync(full).isFile()) {
                    return full;
                }
            }
            catch {
                // ignore inaccessible path
            }
        }
    }
    return 'agy';
}
function describeNativeAction(toolInfo) {
    const parameters = toolInfo && typeof toolInfo === 'object' ? toolInfo.parameters : null;
    if (parameters && typeof parameters === 'object') {
        for (const key of ['Path', 'path', 'file_path', 'TargetFile', 'target_file', 'CommandLine', 'command', 'url']) {
            const value = parameters[key];
            if (typeof value === 'string' && value.trim())
                return value.trim();
        }
    }
    for (const key of ['toolAction', 'tool_action', 'toolSummary', 'tool_summary']) {
        const value = toolInfo && toolInfo[key];
        if (typeof value === 'string' && value.trim())
            return value.trim();
    }
    return undefined;
}
export function mapNativeToolToCausyne(name, rawParams, index) {
    if (!name || typeof name !== 'string')
        return null;
    const lowerName = name.toLowerCase().replace(/[_-]/g, '');
    const params = rawParams && typeof rawParams === 'object' ? rawParams : {};
    if (lowerName === 'runcommand' || lowerName === 'command' || lowerName === 'sysrun' || lowerName === 'terminal' || lowerName === 'bash' || lowerName === 'shell') {
        const rawCmd = params.CommandLine ?? params.command ?? params.cmd ?? params.input ?? params.detail ?? '';
        let cmd = typeof rawCmd === 'string' ? rawCmd.trim() : '';
        if (!cmd && typeof params.parameters === 'object' && params.parameters) {
            cmd = String(params.parameters.CommandLine || params.parameters.command || params.parameters.cmd || '').trim();
        }
        if (cmd) {
            const args = { command: cmd };
            const cwd = params.Cwd ?? params.cwd;
            if (typeof cwd === 'string' && cwd.trim())
                args.cwd = cwd.trim();
            return {
                id: `agy_native_${Date.now()}_${index}`,
                type: 'function',
                function: {
                    name: 'sysRun',
                    arguments: JSON.stringify(args)
                }
            };
        }
    }
    if (lowerName === 'viewfile' || lowerName === 'readfile' || lowerName === 'read' || lowerName === 'view' || lowerName === 'fsread') {
        const filePath = params.AbsolutePath ?? params.path ?? params.file_path ?? params.TargetFile ?? '';
        if (typeof filePath === 'string' && filePath.trim()) {
            return {
                id: `agy_native_${Date.now()}_${index}`,
                type: 'function',
                function: {
                    name: 'fs_read',
                    arguments: JSON.stringify({ path: filePath.trim() })
                }
            };
        }
    }
    if (lowerName === 'listdir' || lowerName === 'fslist' || lowerName === 'list') {
        const dirPath = params.DirectoryPath ?? params.path ?? '.';
        return {
            id: `agy_native_${Date.now()}_${index}`,
            type: 'function',
            function: {
                name: 'fs_list',
                arguments: JSON.stringify({ path: String(dirPath).trim() || '.' })
            }
        };
    }
    if (lowerName === 'grepsearch' || lowerName === 'searchworkspace') {
        const query = params.Query ?? params.query ?? '';
        if (typeof query === 'string' && query.trim()) {
            return {
                id: `agy_native_${Date.now()}_${index}`,
                type: 'function',
                function: {
                    name: 'workspace_search',
                    arguments: JSON.stringify({
                        query: query.trim(),
                        path: params.SearchPath ?? params.path ?? '.'
                    })
                }
            };
        }
    }
    if (lowerName === 'writetofile' || lowerName === 'fswrite') {
        const filePath = params.TargetFile ?? params.path ?? params.file_path ?? '';
        const content = params.CodeContent ?? params.content ?? '';
        if (typeof filePath === 'string' && filePath.trim()) {
            return {
                id: `agy_native_${Date.now()}_${index}`,
                type: 'function',
                function: {
                    name: 'fs_write',
                    arguments: JSON.stringify({ path: filePath.trim(), content: String(content) })
                }
            };
        }
    }
    if (lowerName === 'replacefilecontent' || lowerName === 'fsedit') {
        const filePath = params.TargetFile ?? params.path ?? params.file_path ?? '';
        const oldText = params.TargetContent ?? params.oldText ?? '';
        const newText = params.ReplacementContent ?? params.newText ?? '';
        if (typeof filePath === 'string' && filePath.trim()) {
            return {
                id: `agy_native_${Date.now()}_${index}`,
                type: 'function',
                function: {
                    name: 'fs_edit',
                    arguments: JSON.stringify({ path: filePath.trim(), oldText: String(oldText), newText: String(newText) })
                }
            };
        }
    }
    if (lowerName === 'openbrowserurl' || lowerName === 'readurlcontent') {
        const url = params.Url ?? params.url ?? '';
        if (typeof url === 'string' && url.trim()) {
            return {
                id: `agy_native_${Date.now()}_${index}`,
                type: 'function',
                function: {
                    name: 'web_fetch',
                    arguments: JSON.stringify({ url: url.trim() })
                }
            };
        }
    }
    if (lowerName === 'searchweb') {
        const query = params.query ?? params.Query ?? '';
        if (typeof query === 'string' && query.trim()) {
            return {
                id: `agy_native_${Date.now()}_${index}`,
                type: 'function',
                function: {
                    name: 'web_search',
                    arguments: JSON.stringify({ query: query.trim() })
                }
            };
        }
    }
    return null;
}
export class AntigravityProvider extends LLMProvider {
    command;
    constructor(config = {}) {
        super(config);
        this.model = config.model || 'Gemini 3.8 Flash (Low)';
        this.command = config.command || resolveAgyBinary();
        this.visionModels = [];
        this.audioModels = [];
    }
    formatConversation(messages, tools = []) {
        const lines = [];
        // Core System boundary instructions
        lines.push('[System Instructions]\n' +
            'You are the execution engine for Causyne Agent, operating inside the user\'s workspace. ' +
            'You may create and edit files in this workspace with your native file tools. ' +
            'Do NOT run terminal commands, use the browser, or call any other host tool directly. ' +
            'When a command, browser action, or other external action is required, output an explicit tool call in this exact format:\n' +
            '<tool_call>{"name": "tool_name", "arguments": { ... }}</tool_call>\n' +
            'Causyne Agent will execute the tool in its secure environment and return the results back to you.\n\n' +
            '[Action Directive]\n' +
            'When the user requests to create, build, code, fix, write, optimize, or implement anything (such as a 3D Three.js game, web app, script, or feature), you MUST immediately invoke the relevant tools to execute the work.\n' +
            'NEVER reply with conversational pleasantries, canned greetings (e.g. "How can I help you today?"), or ask what the user wants when an instruction has already been provided.\n' +
            'You must directly generate the code and call the appropriate tool (such as fs_write, sysRun, or file_write) to build what was requested.\n\n' +
            '[Environment State & Idempotency Directive]\n' +
            'The host environment state has already been checked. Do NOT repeatedly re-verify dependencies (e.g. NumPy, Python packages, Node modules, directory listings) if the result is already present in the conversation history above.\n' +
            'When dependency checks have returned, immediately proceed to creating, writing, and editing the required code files (e.g. using fs_write or file editing).\n\n' +
            '[Language & Communication Directive]\n' +
            'Dynamically reflect and match the exact language used by the user in their prompt. If the user writes in English, you must respond strictly in English. Default to English for all responses and reasoning. Never default to Indonesian or send canned greetings in Indonesian.');
        if (tools && tools.length > 0) {
            const toolSummaries = tools.map(t => {
                const name = t.name || t.function?.name || 'unknown';
                const desc = t.description || t.function?.description || '';
                const params = t.parameters || t.input_schema || t.function?.parameters || {};
                const paramKeys = Object.keys(params.properties || {}).join(', ');
                return `- ${name}(${paramKeys}): ${desc}`;
            }).join('\n');
            lines.push(`[Available Tools]\nYou may invoke tools when needed by outputting:\n<tool_call>{"name": "tool_name", "arguments": { ... }}</tool_call>\n\n${toolSummaries}`);
        }
        for (const msg of messages) {
            const role = msg.role === 'user'
                ? 'User'
                : (msg.role === 'assistant'
                    ? 'Assistant'
                    : (msg.role === 'system'
                        ? 'System Instructions'
                        : (msg.role === 'tool'
                            ? `Tool Result (${msg.name || 'tool'})`
                            : 'Context')));
            let text = '';
            if (typeof msg.content === 'string') {
                text = msg.content;
            }
            else if (Array.isArray(msg.content)) {
                text = msg.content.map((c) => typeof c === 'string' ? c : (c?.text || '')).filter(Boolean).join('\n');
            }
            if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
                for (const tc of msg.tool_calls) {
                    const fn = tc.function || {};
                    const fnArgs = typeof fn.arguments === 'string' ? fn.arguments : JSON.stringify(fn.arguments || {});
                    text += `\n<tool_call>{"name": "${fn.name}", "arguments": ${fnArgs}}</tool_call>`;
                }
            }
            if (text.trim()) {
                lines.push(`[${role}]\n${text.trim()}`);
            }
        }
        return lines.join('\n\n');
    }
    extractToolCalls(text) {
        const calls = [];
        if (!text || typeof text !== 'string')
            return calls;
        const regex = /<tool_call>([\s\S]*?)<\/tool_call>/g;
        let match;
        let index = 0;
        while ((match = regex.exec(text)) !== null) {
            try {
                const raw = match[1]?.trim() || '';
                const parsed = JSON.parse(raw);
                const name = parsed.name || parsed.tool || parsed.function?.name;
                if (name) {
                    const rawArgs = parsed.arguments !== undefined ? parsed.arguments : (parsed.parameters !== undefined ? parsed.parameters : (parsed.input !== undefined ? parsed.input : (parsed.function?.arguments || {})));
                    calls.push({
                        id: `agy_call_${Date.now()}_${index++}`,
                        type: 'function',
                        function: {
                            name,
                            arguments: typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs || {})
                        }
                    });
                }
            }
            catch {
                // ignore malformed tool_call blocks
            }
        }
        if (calls.length === 0) {
            const fenceRegex = /```(?:tool_call|json)?\s*(\{[\s\S]*?"name"\s*:\s*[\s\S]*?\})\s*```/g;
            while ((match = fenceRegex.exec(text)) !== null) {
                try {
                    const raw = match[1]?.trim() || '';
                    const parsed = JSON.parse(raw);
                    const name = parsed.name || parsed.tool || parsed.function?.name;
                    if (name) {
                        const rawArgs = parsed.arguments !== undefined ? parsed.arguments : (parsed.parameters !== undefined ? parsed.parameters : (parsed.input !== undefined ? parsed.input : (parsed.function?.arguments || {})));
                        calls.push({
                            id: `agy_call_${Date.now()}_${index++}`,
                            type: 'function',
                            function: {
                                name,
                                arguments: typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs || {})
                            }
                        });
                    }
                }
                catch {
                    // ignore
                }
            }
        }
        // Unclosed tool_call recovery (when model generated large file content and closed turn)
        if (calls.length === 0) {
            const openIndex = text.lastIndexOf('<tool_call>');
            if (openIndex !== -1 && text.indexOf('</tool_call>', openIndex) === -1) {
                const partial = text.slice(openIndex + '<tool_call>'.length).trim();
                for (const suffix of ['', '}', '}}', '}}}', '"}', '"}}', '"}}}', '"}]}}', '"]}}', '"]}}}']) {
                    try {
                        const parsed = JSON.parse(partial + suffix);
                        const name = parsed.name || parsed.tool || parsed.function?.name;
                        if (name) {
                            const rawArgs = parsed.arguments !== undefined ? parsed.arguments : (parsed.parameters !== undefined ? parsed.parameters : (parsed.input !== undefined ? parsed.input : (parsed.function?.arguments || {})));
                            calls.push({
                                id: `agy_call_${Date.now()}_0`,
                                type: 'function',
                                function: {
                                    name,
                                    arguments: typeof rawArgs === 'string' ? rawArgs : JSON.stringify(rawArgs || {})
                                }
                            });
                            break;
                        }
                    }
                    catch {
                        // try next candidate
                    }
                }
            }
        }
        return calls;
    }
    _isTransientError(errMessage) {
        if (!errMessage)
            return false;
        const msg = String(errMessage).toLowerCase();
        return msg.includes('connection reset') ||
            msg.includes('econnreset') ||
            msg.includes('etimedout') ||
            msg.includes('streamgeneratecontent') ||
            msg.includes('socket hang up') ||
            msg.includes('network error') ||
            msg.includes('temporarily unavailable') ||
            msg.includes('status 503') ||
            msg.includes('status 504') ||
            msg.includes('status 429');
    }
    async _executeOnce(messages, options = {}) {
        const promptText = this.formatConversation(messages, options.tools);
        const modelSlug = resolveAgyModelId(this.model);
        const effort = resolveAgyEffort(this.model);
        // Standard high-performance non-blocking CLI invocation:
        // 1. stream-json output for real-time responsiveness and non-buffering progress.
        // 2. --disable-slash-commands prevents sluggish filesystem and customization scans.
        // 3. agy only treats stdin as a prompt in stream-json input mode. Plain text
        //    stdin without --print starts an interactive session and loses the task.
        //    Keep the prompt off the process command line by sending one user event.
        // 4. --mode accept-edits lets agy create and edit workspace files in
        //    headless mode, where the default request-review policy cannot prompt
        //    and would auto-deny every write. --dangerously-skip-permissions must
        //    stay off: it would also grant shell commands and other host tools,
        //    bypassing Causyne. Native terminal/browser tools remain denied; those
        //    must go through Causyne XML tool calls.
        // 5. --print-timeout 300s provides ample window for large code generation without truncation.
        const args = [
            '--mode',
            'accept-edits',
            '--input-format',
            'stream-json',
            '--output-format',
            'stream-json',
            '--disable-slash-commands',
            '--print-timeout',
            '300s',
            '--model',
            modelSlug,
            '--effort',
            effort
        ];
        return new Promise((resolve, reject) => {
            let isSettled = false;
            const child = spawn(this.command, args, {
                cwd: process.cwd(),
                env: process.env,
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true
            });
            let stdoutBuffer = '';
            let stderrBuffer = '';
            let streamedResponse = '';
            let finalResultObj = null;
            const nativeActions = [];
            const attemptedNativeTools = [];
            let childClosed = false;
            const cleanup = () => {
                if (options.signal) {
                    options.signal.removeEventListener('abort', onAbort);
                }
            };
            const safeReject = (err) => {
                if (isSettled)
                    return;
                isSettled = true;
                cleanup();
                reject(err);
            };
            const safeResolve = (res) => {
                if (isSettled)
                    return;
                isSettled = true;
                cleanup();
                resolve(res);
            };
            const onAbort = () => {
                try {
                    child.kill('SIGTERM');
                    setTimeout(() => {
                        if (!childClosed)
                            child.kill('SIGKILL');
                    }, 1000).unref();
                }
                catch {
                    // ignore kill errors
                }
                safeReject(new Error('Turn aborted by user or timeout.'));
            };
            if (options.signal) {
                if (options.signal.aborted) {
                    onAbort();
                    return;
                }
                options.signal.addEventListener('abort', onAbort, { once: true });
            }
            // Feed prompt directly into child process stdin, then close stdin
            try {
                child.stdin.on('error', () => { });
                child.stdin.write(JSON.stringify({ event: 'user', message: { content: promptText } }) + '\n', 'utf8');
                child.stdin.end();
            }
            catch (err) {
                safeReject(new Error(`Failed to pipe prompt to Antigravity CLI: ${err.message}`));
                return;
            }
            child.stdout.setEncoding('utf8');
            child.stdout.on('data', (chunk) => {
                stdoutBuffer += chunk;
                // Process line-delimited stream-json events
                const lines = stdoutBuffer.split('\n');
                stdoutBuffer = lines.pop() || ''; // Keep incomplete trailing fragment in buffer
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed)
                        continue;
                    try {
                        const event = JSON.parse(trimmed);
                        if (event.event === 'step_update') {
                            const stepUpdate = event.step_update;
                            const delta = stepUpdate?.text_delta;
                            const stepType = stepUpdate?.step_type;
                            if (stepType === 'tool') {
                                const state = stepUpdate?.state;
                                const toolInfo = stepUpdate?.tool_info || {};
                                const name = stepUpdate?.tool_name || toolInfo?.name;
                                const status = state === 'DONE'
                                    ? 'completed'
                                    : (state === 'ERROR' ? 'failed' : 'running');
                                const rawParams = (toolInfo && typeof toolInfo === 'object' && toolInfo.parameters) ||
                                    (stepUpdate && typeof stepUpdate === 'object' && stepUpdate.parameters) ||
                                    (toolInfo && typeof toolInfo === 'object' && toolInfo.input) ||
                                    {};
                                if (name) {
                                    const existingAttempt = attemptedNativeTools.find(a => a.name === name && a.status === 'running');
                                    if (existingAttempt) {
                                        existingAttempt.status = status;
                                        if (rawParams && Object.keys(rawParams).length > 0) {
                                            existingAttempt.parameters = { ...existingAttempt.parameters, ...rawParams };
                                        }
                                        if (toolInfo?.error?.message)
                                            existingAttempt.error = toolInfo.error.message;
                                    }
                                    else {
                                        attemptedNativeTools.push({
                                            name,
                                            parameters: { ...rawParams },
                                            status,
                                            error: toolInfo?.error?.message,
                                            detail: describeNativeAction(toolInfo) || describeNativeAction({ parameters: rawParams })
                                        });
                                    }
                                }
                                if (name && (state === 'ACTIVE' || state === 'DONE' || state === 'ERROR')) {
                                    const detail = describeNativeAction(toolInfo) || describeNativeAction({ parameters: rawParams });
                                    const action = {
                                        name,
                                        status,
                                        ...(detail ? { detail } : {})
                                    };
                                    if (status !== 'running') {
                                        const existing = nativeActions.find(a => a.name === action.name && a.detail === action.detail);
                                        if (existing)
                                            existing.status = status;
                                        else
                                            nativeActions.push(action);
                                    }
                                    // A DONE event can still be denied in the final result.
                                    if (status === 'running' && typeof options.onNativeAction === 'function') {
                                        options.onNativeAction(action);
                                    }
                                }
                            }
                            if (delta && typeof delta === 'string') {
                                if (stepType === 'thought' || stepType === 'agent_thought') {
                                    if (typeof options.onReasoningChunk === 'function') {
                                        options.onReasoningChunk(delta);
                                    }
                                }
                                else {
                                    streamedResponse += delta;
                                    if (typeof options.onChunk === 'function') {
                                        options.onChunk(delta);
                                    }
                                }
                            }
                        }
                        else if (event.event === 'result') {
                            finalResultObj = event.result;
                        }
                        else if (event.status === 'ERROR') {
                            safeReject(new Error(`Antigravity Agent returned error: ${event.error || 'Unknown error'}`));
                            return;
                        }
                    }
                    catch {
                        // Non-JSON line (fallback log)
                    }
                }
            });
            child.stderr.setEncoding('utf8');
            child.stderr.on('data', (chunk) => {
                stderrBuffer += chunk;
            });
            child.on('error', (err) => {
                safeReject(new Error(`Antigravity Agent (agy) spawn error: ${err.message}. Make sure Antigravity CLI is installed.`));
            });
            child.on('close', (code) => {
                childClosed = true;
                // Process any remaining bytes in stdoutBuffer
                if (stdoutBuffer.trim()) {
                    try {
                        const event = JSON.parse(stdoutBuffer.trim());
                        if (event.event === 'result') {
                            finalResultObj = event.result;
                        }
                        else if (event.status === 'ERROR') {
                            safeReject(new Error(`Antigravity Agent returned error: ${event.error || 'Unknown error'}`));
                            return;
                        }
                    }
                    catch {
                        // ignore
                    }
                }
                if (code !== 0 || finalResultObj?.status === 'ERROR') {
                    const errDetail = finalResultObj?.error || stderrBuffer.trim() || `exit code ${code}`;
                    safeReject(new Error(`Antigravity Agent (agy) failed: ${errDetail}`));
                    return;
                }
                let rawContent = (finalResultObj?.response || streamedResponse || '').trim();
                let extractedReasoning = finalResultObj?.reasoning || finalResultObj?.thought || '';
                // Extract <thought> or <thinking> blocks if present in rawContent
                const thoughtMatch = /<(?:thought|thinking)>([\s\S]*?)<\/(?:thought|thinking)>/i.exec(rawContent);
                if (thoughtMatch && thoughtMatch[1]) {
                    extractedReasoning = (extractedReasoning ? extractedReasoning + '\n' : '') + thoughtMatch[1].trim();
                    rawContent = rawContent.replace(/<(?:thought|thinking)>[\s\S]*?<\/(?:thought|thinking)>/gi, '').trim();
                }
                const toolCalls = this.extractToolCalls(rawContent);
                // Strip tool call tags from prose so raw XML does not leak into chat display
                let content = rawContent.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim();
                const deniedActions = Array.isArray(finalResultObj?.denied_actions)
                    ? finalResultObj.denied_actions : [];
                const normalizeAction = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');
                const deniedNames = new Set(deniedActions.flatMap(action => [normalizeAction(action?.action), normalizeAction(action?.display_name)]).filter(Boolean));
                for (const action of nativeActions) {
                    if (deniedNames.has(normalizeAction(action.name)))
                        action.status = 'failed';
                    if (typeof options.onNativeAction === 'function')
                        options.onNativeAction(action);
                }
                if (deniedActions.length > 0) {
                    const unmapped = [];
                    for (const denied of deniedActions) {
                        const name = String(denied?.action || denied?.display_name || 'unknown');
                        const attempt = [...attemptedNativeTools].reverse().find(candidate => normalizeAction(candidate.name) === normalizeAction(name)
                            || normalizeAction(candidate.name) === normalizeAction(denied?.display_name));
                        const parameters = {
                            ...(attempt?.parameters || {}),
                            ...(denied?.parameters || {}),
                            ...(attempt?.detail ? { detail: attempt.detail } : {})
                        };
                        const mapped = mapNativeToolToCausyne(attempt?.name || String(denied?.display_name || name), parameters, toolCalls.length);
                        if (!mapped) {
                            unmapped.push(String(denied?.display_name || name));
                            continue;
                        }
                        if (!toolCalls.some(call => call.function.name === mapped.function.name
                            && call.function.arguments === mapped.function.arguments)) {
                            toolCalls.push(mapped);
                        }
                    }
                    if (unmapped.length > 0) {
                        const error = new Error(`Antigravity could not perform: ${unmapped.join(', ')}. The denied action had no safe Causyne tool mapping.`);
                        error.code = 'AGY_NATIVE_ACTION_DENIED';
                        safeReject(error);
                        return;
                    }
                    // Any prose produced alongside a denied action may claim work that
                    // did not occur. Wait for the mapped Causyne tool result instead.
                    content = '';
                }
                const completedNativeActions = nativeActions.filter((a) => a.status === 'completed');
                if (!content && completedNativeActions.length > 0) {
                    content = `Antigravity completed: ${completedNativeActions
                        .map((a) => `${a.name}${a.detail ? ` (${a.detail})` : ''}`)
                        .join(', ')}`;
                }
                if (!content && toolCalls.length === 0) {
                    const detail = stderrBuffer.trim();
                    safeReject(new Error(detail
                        ? `Antigravity returned no response: ${detail}`
                        : 'Antigravity returned no response.'));
                    return;
                }
                const promptTokens = Number(finalResultObj?.usage?.input_tokens) || Math.ceil(promptText.length / 4);
                const completionTokens = Number(finalResultObj?.usage?.output_tokens) || Math.ceil(rawContent.length / 4);
                const thinkingTokens = Number(finalResultObj?.usage?.thinking_tokens) || 0;
                const response = {
                    content,
                    usage: {
                        promptTokens,
                        completionTokens: completionTokens + thinkingTokens,
                        cachedPromptTokens: Number(finalResultObj?.usage?.cache_read_tokens) || 0
                    }
                };
                if (extractedReasoning) {
                    response.reasoningContent = extractedReasoning;
                }
                if (toolCalls.length > 0) {
                    response.toolCalls = toolCalls;
                }
                if (nativeActions.length > 0) {
                    response.externalActions = nativeActions.filter((a) => a.status !== 'running');
                }
                safeResolve(response);
            });
        });
    }
    async chat(messages, options = {}) {
        const maxRetries = options.maxRetries ?? 2;
        let attempt = 0;
        while (attempt <= maxRetries) {
            try {
                return await this._executeOnce(messages, options);
            }
            catch (err) {
                if (attempt < maxRetries && this._isTransientError(err.message)) {
                    attempt++;
                    const delay = attempt * 1200;
                    await new Promise(r => setTimeout(r, delay));
                    continue;
                }
                throw err;
            }
        }
        throw new Error('Antigravity execution failed after maximum retries.');
    }
}
