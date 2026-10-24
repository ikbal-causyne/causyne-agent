import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { LLMProvider } from './base.js';
/**
 * Display label → the id `agy --model` actually accepts, exactly as reported
 * by `agy models`. The CLI exposes slugs; the picker shows the readable label.
 * Passing the label through unchanged is what a user would try, so both forms
 * resolve here rather than failing at the provider.
 */
export const ANTIGRAVITY_MODEL_IDS = {
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
export const ANTIGRAVITY_LABEL_BY_ID = Object.fromEntries(Object.entries(ANTIGRAVITY_MODEL_IDS).map(([label, id]) => [id, label]));
export const ANTIGRAVITY_MODELS = Object.keys(ANTIGRAVITY_MODEL_IDS);
export function resolveAgyModelId(model) {
    if (typeof model !== 'string')
        return '';
    const trimmed = model.trim();
    return ANTIGRAVITY_MODEL_IDS[trimmed] || trimmed;
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
            'You are acting as an AI reasoning engine for Causyne Agent. Do NOT invoke your own internal host CLI tools or execute commands directly. ' +
            'When an action or tool is required, output an explicit tool call in this exact format:\n' +
            '<tool_call>{"name": "tool_name", "arguments": { ... }}</tool_call>\n' +
            'Causyne Agent will execute the tool in its secure environment and return the results back to you.\n\n' +
            '[Action Directive]\n' +
            'When the user requests to create, build, code, fix, write, optimize, or implement anything (such as a 3D Three.js game, web app, script, or feature), you MUST immediately invoke the relevant tools to execute the work.\n' +
            'NEVER reply with conversational pleasantries, canned greetings (e.g. "How can I help you today?"), or ask what the user wants when an instruction has already been provided.\n' +
            'You must directly generate the code and call the appropriate tool (such as fs_write, sysRun, or file_write) to build what was requested.\n\n' +
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
        // 3. The prompt is piped through stdin. `-p -` cannot be used: agy treats the
        //    literal "-" as the prompt, ignores stdin, and answers with its default
        //    greeting — the conversation never reaches the model.
        // 4. --dangerously-skip-permissions must stay off. agy is a full agent CLI;
        //    granting it tools lets it run its own commands in this workspace instead
        //    of answering through Causyne, and an all-tools turn produces no prose.
        //    With permissions denied in headless mode it answers as a reasoning engine.
        // 5. --print-timeout 300s provides ample window for large code generation without truncation.
        const args = [
            '--input-format',
            'text',
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
                        if (!child.killed)
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
                child.stdin.write(promptText, 'utf8');
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
                if (code !== 0 && !streamedResponse && !finalResultObj) {
                    const errDetail = stderrBuffer.trim() || `exit code ${code}`;
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
                if (!content && Array.isArray(finalResultObj?.denied_actions) && finalResultObj.denied_actions.length > 0) {
                    content = `Antigravity attempted action: ${finalResultObj.denied_actions.map((a) => a.display_name || a.action).join(', ')}`;
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
