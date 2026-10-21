import { spawn } from 'node:child_process';
import { ACP_ERROR_CODES, ACP_METHODS, ACP_PROTOCOL_VERSION, isJsonRpcRequest, isJsonRpcResponse } from './protocol.js';
const MAX_STDERR_CHARS = 4000;
const MAX_UPDATE_CHARS = 200_000;
export class AcpClient {
    options;
    child = null;
    buffer = '';
    stderrTail = '';
    pending = new Map();
    nextId = 1;
    closed = false;
    exitError = null;
    constructor(options) {
        this.options = options;
    }
    get command() {
        return this.options.command;
    }
    async start() {
        if (this.child)
            throw new Error('client already started');
        const args = this.options.args ?? [];
        const child = spawn(this.options.command, args, {
            cwd: this.options.cwd,
            env: this.options.env ?? process.env,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true
        });
        this.child = child;
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
            this.buffer += chunk;
            void this.drain();
        });
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => {
            this.stderrTail = `${this.stderrTail}${chunk}`.slice(-MAX_STDERR_CHARS);
        });
        child.on('error', (error) => this.failAll(new Error(`agent process failed: ${error.message}`)));
        child.on('exit', (code, signal) => {
            const detail = this.stderrTail.trim() || `exit code ${code ?? 'null'}${signal ? ` signal ${signal}` : ''}`;
            this.failAll(new Error(`agent process exited: ${detail}`));
        });
        const params = {
            protocolVersion: ACP_PROTOCOL_VERSION,
            clientCapabilities: {
                fs: { readTextFile: false, writeTextFile: false },
                terminal: false,
                session: { notices: false }
            },
            clientInfo: { name: 'Causyne Agent', version: this.options.clientVersion ?? '0.0.0' }
        };
        return await this.request(ACP_METHODS.INITIALIZE, params, 30_000);
    }
    async newSession(cwd, mcpServers = []) {
        const result = await this.request(ACP_METHODS.NEW_SESSION, {
            cwd,
            mcpServers
        }, 30_000);
        if (!result || typeof result.sessionId !== 'string' || !result.sessionId) {
            throw new Error('agent did not return a session id');
        }
        return result.sessionId;
    }
    async prompt(sessionId, text) {
        const blocks = [{ type: 'text', text }];
        let collected = '';
        const collector = (update) => {
            if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
                collected = `${collected}${update.content.text}`.slice(0, MAX_UPDATE_CHARS);
            }
        };
        const previous = this.updateListener;
        this.updateListener = (sessionIdFromEvent, update) => {
            previous?.(sessionIdFromEvent, update);
            if (sessionIdFromEvent === sessionId)
                collector(update);
        };
        try {
            const response = await this.request(ACP_METHODS.PROMPT, {
                sessionId,
                prompt: blocks
            }, this.options.promptTimeoutMs ?? 15 * 60 * 1000);
            return {
                stopReason: response?.stopReason ?? 'end_turn',
                text: collected
            };
        }
        finally {
            this.updateListener = previous;
        }
    }
    notifyCancel(sessionId) {
        this.write({
            jsonrpc: '2.0',
            method: ACP_METHODS.CANCEL,
            params: { sessionId }
        });
    }
    async close() {
        if (this.closed)
            return;
        this.closed = true;
        const child = this.child;
        this.failAll(new Error('client closed'));
        if (!child)
            return;
        await new Promise((resolve) => {
            const timer = setTimeout(() => {
                child.kill('SIGKILL');
                resolve();
            }, 1500);
            child.once('exit', () => {
                clearTimeout(timer);
                resolve();
            });
            child.kill('SIGTERM');
        });
        this.child = null;
    }
    updateListener = null;
    write(message) {
        if (!this.child || this.closed)
            return;
        try {
            this.child.stdin.write(`${JSON.stringify(message)}\n`);
        }
        catch {
            // A dead pipe surfaces through the exit handler.
        }
    }
    async drain() {
        let index = this.buffer.indexOf('\n');
        while (index >= 0) {
            const line = this.buffer.slice(0, index).trim();
            this.buffer = this.buffer.slice(index + 1);
            if (line)
                await this.handleLine(line);
            index = this.buffer.indexOf('\n');
        }
    }
    async handleLine(line) {
        let parsed;
        try {
            parsed = JSON.parse(line);
        }
        catch {
            return;
        }
        if (isJsonRpcResponse(parsed)) {
            this.settle(parsed);
            return;
        }
        if (isJsonRpcRequest(parsed)) {
            await this.handleServerRequest(parsed);
            return;
        }
        const method = parsed.method;
        if (method === ACP_METHODS.UPDATE) {
            const params = parsed.params;
            if (params && typeof params.sessionId === 'string' && params.update) {
                this.updateListener?.(params.sessionId, params.update);
            }
        }
    }
    async handleServerRequest(request) {
        if (request.method === ACP_METHODS.REQUEST_PERMISSION) {
            const handler = this.options.permissionHandler;
            if (!handler) {
                this.write({
                    jsonrpc: '2.0',
                    id: request.id,
                    result: { outcome: { outcome: 'cancelled' } }
                });
                return;
            }
            try {
                const outcome = await handler(request.params);
                this.write({ jsonrpc: '2.0', id: request.id, result: { outcome } });
            }
            catch {
                this.write({ jsonrpc: '2.0', id: request.id, result: { outcome: { outcome: 'cancelled' } } });
            }
            return;
        }
        this.write({
            jsonrpc: '2.0',
            id: request.id,
            error: { code: ACP_ERROR_CODES.METHOD_NOT_FOUND, message: `Unsupported client method: ${request.method}` }
        });
    }
    settle(response) {
        if (response.id === null || response.id === undefined)
            return;
        const pending = this.pending.get(response.id);
        if (!pending)
            return;
        clearTimeout(pending.timer);
        this.pending.delete(response.id);
        if (response.error) {
            pending.reject(new Error(`${pending.method} failed: ${response.error.message}`));
            return;
        }
        pending.resolve(response.result);
    }
    request(method, params, timeoutMs) {
        if (!this.child || this.closed)
            return Promise.reject(new Error('agent process is not running'));
        if (this.exitError)
            return Promise.reject(this.exitError);
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`${method} timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            this.pending.set(id, {
                resolve: (value) => resolve(value),
                reject,
                timer,
                method
            });
            this.write({ jsonrpc: '2.0', id, method, params });
        });
    }
    failAll(error) {
        this.exitError = error;
        for (const [id, pending] of this.pending) {
            clearTimeout(pending.timer);
            pending.reject(error);
            this.pending.delete(id);
        }
    }
}
