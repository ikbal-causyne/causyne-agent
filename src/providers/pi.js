import { spawn } from 'node:child_process';
import { AcpProvider } from './acp.js';
import { LLMProvider } from './base.js';
export function isPiProvider(provider) {
    return typeof provider === 'string' && provider.toLowerCase() === 'pi';
}
export const PI_SETUP_PROVIDER = {
    id: 'pi', label: 'Pi coding agent', hint: 'local Pi RPC · uses Causyne tools',
    category: 'Peer Agent', model: 'default'
};
/** Pi supplies reasoning over RPC; Causyne remains the sole executor of tools. */
export class PiProvider extends LLMProvider {
    command;
    formatter;
    constructor(config = {}) {
        super(config);
        this.command = config.command || 'pi';
        this.model = config.model || 'default';
        this.formatter = new AcpProvider({ provider: 'acp/opencode' });
        this.visionModels = [];
        this.audioModels = [];
    }
    async chat(messages, options = {}) {
        const args = ['--mode', 'rpc', '--no-session', '--no-tools', '--no-extensions',
            '--no-mcp', '--no-context-files', '--no-skills', '--no-prompt-templates'];
        if (this.model !== 'default')
            args.push('--model', this.model);
        const cwd = typeof options.workspaceRoot === 'string' && options.workspaceRoot
            ? options.workspaceRoot : process.cwd();
        const prompt = this.formatter.formatConversation(messages, options.tools || [])
            .replace('over ACP.', 'over Pi RPC.');
        return new Promise((resolve, reject) => {
            const child = spawn(this.command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'],
                env: process.env, shell: false });
            let buffer = '';
            let stderr = '';
            let streamed = '';
            let finalText = '';
            let stopReason = '';
            let acknowledged = false;
            let settled = false;
            let finished = false;
            let usage = { promptTokens: 0, completionTokens: 0, cachedPromptTokens: 0 };
            const cleanup = () => {
                options.signal?.removeEventListener('abort', abort);
                child.stdin.end();
                if (!child.killed)
                    child.kill();
            };
            const fail = (error) => {
                if (finished)
                    return;
                finished = true;
                cleanup();
                reject(error);
            };
            const complete = () => {
                if (finished || !acknowledged || !settled)
                    return;
                if (stopReason === 'error' || stopReason === 'aborted') {
                    fail(new Error(`Pi ended with ${stopReason}${stderr ? `: ${stderr.slice(-400)}` : ''}`));
                    return;
                }
                finished = true;
                cleanup();
                const raw = finalText || streamed;
                resolve({
                    content: raw.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '').trim(),
                    usage,
                    toolCalls: this.formatter.extractToolCalls(raw)
                });
            };
            const abort = () => {
                const err = new Error('Pi request aborted');
                err.name = 'AbortError';
                fail(err);
            };
            if (options.signal?.aborted) {
                abort();
                return;
            }
            options.signal?.addEventListener('abort', abort, { once: true });
            const handle = (record) => {
                if (record.type === 'response' && record.id === 'causyne-state') {
                    if (!record.success || !record.data?.model
                        || record.data.model.provider === 'unknown' || record.data.model.id === 'unknown') {
                        fail(new Error('Pi has no active model. Open Pi and configure a model login before selecting Pi in Causyne.'));
                        return;
                    }
                    child.stdin.write(JSON.stringify({ id: 'causyne-prompt', type: 'prompt', message: prompt }) + '\n');
                }
                else if (record.type === 'response' && record.id === 'causyne-prompt') {
                    if (!record.success) {
                        fail(new Error(`Pi rejected the prompt: ${String(record.error || 'unknown error')}`));
                        return;
                    }
                    acknowledged = true;
                    if (record.data?.disposition === 'handled')
                        settled = true;
                    complete();
                }
                else if (record.type === 'message_update') {
                    const update = record.assistantMessageEvent;
                    if (update?.type === 'text_delta' && typeof update.delta === 'string') {
                        streamed += update.delta;
                        options.onChunk?.(update.delta);
                    }
                    else if (update?.type === 'thinking_delta' && typeof update.delta === 'string') {
                        options.onReasoningChunk?.(update.delta);
                    }
                }
                else if (record.type === 'message_end' && record.message?.role === 'assistant') {
                    const message = record.message;
                    finalText = Array.isArray(message.content)
                        ? message.content.filter((part) => part?.type === 'text').map((part) => String(part.text || '')).join('')
                        : String(message.content || '');
                    stopReason = String(message.stopReason || '');
                    const data = message.usage || {};
                    usage = {
                        promptTokens: Number(data.input) || 0,
                        uncachedPromptTokens: Number(data.input) || 0,
                        completionTokens: Number(data.output) || 0,
                        cachedPromptTokens: Number(data.cacheRead) || 0,
                        measurement: data.input != null && data.output != null ? 'provider_reported' : 'text_estimate',
                        cacheMeasurement: data.cacheRead != null ? 'provider_reported' : 'unavailable'
                    };
                }
                else if (record.type === 'agent_settled') {
                    if (record.aborted)
                        stopReason = 'aborted';
                    settled = true;
                    complete();
                }
            };
            child.stdout.setEncoding('utf8');
            child.stdout.on('data', (chunk) => {
                buffer += chunk;
                let index;
                while ((index = buffer.indexOf('\n')) >= 0) {
                    const line = buffer.slice(0, index).replace(/\r$/, '');
                    buffer = buffer.slice(index + 1);
                    if (!line)
                        continue;
                    try {
                        handle(JSON.parse(line));
                    }
                    catch (error) {
                        fail(new Error(`Invalid Pi RPC record: ${String(error)}`));
                        return;
                    }
                }
            });
            child.stderr.setEncoding('utf8');
            child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000); });
            child.on('error', error => fail(new Error(`Pi CLI unavailable: ${error.message}`)));
            child.on('close', code => {
                if (!finished)
                    fail(new Error(`Pi RPC exited before completion (${code ?? 'unknown'})${stderr ? `: ${stderr.slice(-400)}` : ''}`));
            });
            child.stdin.on('error', error => fail(new Error(`Pi RPC input failed: ${error.message}`)));
            child.stdin.write(JSON.stringify({ id: 'causyne-state', type: 'get_state' }) + '\n');
        });
    }
}
