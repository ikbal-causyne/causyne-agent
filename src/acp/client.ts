import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ACP_ERROR_CODES,
  ACP_METHODS,
  ACP_PROTOCOL_VERSION,
  extractAcpSessionModels,
  isJsonRpcRequest,
  isJsonRpcResponse
} from './protocol.js';
import type {
  AcpDiscoveredSessionModels,
  ContentBlock,
  InitializeRequest,
  InitializeResult,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  SessionUpdate,
  AgentCapabilities,
  AgentInfo,
  ReadTextFileRequest,
  ReadTextFileResponse,
  WriteTextFileRequest,
  WriteTextFileResponse
} from './protocol.js';

export interface AcpClientOptions {
  command: string;
  args?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
  clientVersion?: string;
  promptTimeoutMs?: number;
  inactivityTimeoutMs?: number;
  allowHostTools?: boolean;
  permissionHandler?: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse['outcome']>;
  onUpdate?: (sessionId: string, update: SessionUpdate) => void;
  fsReadHandler?: (filePath: string, options?: { line?: number; limit?: number }) => Promise<string>;
  fsWriteHandler?: (filePath: string, content: string) => Promise<void>;
}

export interface AcpPromptResult {
  stopReason: PromptResponse['stopReason'];
  text: string;
  usage?: PromptResponse['usage'];
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  inactivityTimer?: NodeJS.Timeout | undefined;
  snifferInterval?: NodeJS.Timeout | undefined;
  method: string;
  cleanup?: (() => void) | undefined;
  notifyActivity?: (() => void) | undefined;
}

function createAbortError(message = 'ACP operation aborted by user'): Error {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

const MAX_STDERR_CHARS = 4000;
const MAX_UPDATE_CHARS = 200_000;

export class AcpClient {
  private readonly options: AcpClientOptions;
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private stderrTail = '';
  private readonly pending = new Map<string | number, PendingRequest>();
  private nextId = 1;
  private closed = false;
  private exitError: Error | null = null;
  private initResult: InitializeResult | null = null;
  private readonly sessionModels = new Map<string, AcpDiscoveredSessionModels>();
  private latestSessionModels: AcpDiscoveredSessionModels = {
    availableModels: [],
    modelLabels: {},
    usesConfigOption: false
  };

  constructor(options: AcpClientOptions) {
    this.options = options;
  }

  get command(): string {
    return this.options.command;
  }

  get agentInfo(): AgentInfo | undefined {
    return this.initResult?.agentInfo;
  }

  get agentCapabilities(): AgentCapabilities | undefined {
    return this.initResult?.agentCapabilities;
  }

  get authMethods(): unknown[] | undefined {
    return this.initResult?.authMethods;
  }

  get discoveredModels(): string[] {
    return [...this.latestSessionModels.availableModels];
  }

  get currentModelId(): string | undefined {
    return this.latestSessionModels.currentModelId;
  }

  get modelLabels(): Record<string, string> {
    return { ...this.latestSessionModels.modelLabels };
  }

  getSessionModels(sessionId?: string): AcpDiscoveredSessionModels {
    if (sessionId && this.sessionModels.has(sessionId)) {
      const state = this.sessionModels.get(sessionId)!;
      return {
        currentModelId: state.currentModelId,
        availableModels: [...state.availableModels],
        modelLabels: { ...state.modelLabels },
        usesConfigOption: state.usesConfigOption,
        configOptionId: state.configOptionId
      };
    }
    return {
      currentModelId: this.latestSessionModels.currentModelId,
      availableModels: [...this.latestSessionModels.availableModels],
      modelLabels: { ...this.latestSessionModels.modelLabels },
      usesConfigOption: this.latestSessionModels.usesConfigOption,
      configOptionId: this.latestSessionModels.configOptionId
    };
  }

  private recordSessionModels(sessionId: string, payload: unknown): void {
    const extracted = extractAcpSessionModels(payload);
    if (extracted.availableModels.length === 0 && !extracted.currentModelId) {
      return;
    }
    const existing = this.sessionModels.get(sessionId);
    const merged: AcpDiscoveredSessionModels = {
      currentModelId: extracted.currentModelId ?? existing?.currentModelId,
      availableModels: extracted.availableModels.length > 0
        ? extracted.availableModels
        : (existing?.availableModels ?? []),
      modelLabels: { ...(existing?.modelLabels ?? {}), ...extracted.modelLabels },
      usesConfigOption: extracted.usesConfigOption || Boolean(existing?.usesConfigOption),
      configOptionId: extracted.configOptionId ?? existing?.configOptionId
    };
    this.sessionModels.set(sessionId, merged);
    this.latestSessionModels = merged;
  }

  async start(signal?: AbortSignal): Promise<InitializeResult> {
    if (signal?.aborted) throw createAbortError();
    if (this.child) throw new Error('client already started');
    const args = this.options.args ?? [];
    const child = spawn(this.options.command, args, {
      cwd: this.options.cwd,
      env: this.options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    this.child = child;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (this.closed) return;
      this.buffer += chunk;
      this.notifyPendingActivity();
      void this.drain();
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-MAX_STDERR_CHARS);
      this.notifyPendingActivity();
    });
    child.on('error', (error) => this.failAll(new Error(`agent process failed: ${error.message}`)));
    child.on('exit', (code, exitSignal) => {
      const detail = this.stderrTail.trim() || `exit code ${code ?? 'null'}${exitSignal ? ` signal ${exitSignal}` : ''}`;
      this.failAll(new Error(`agent process exited: ${detail}`));
    });

    const hasFsRead = this.options.allowHostTools !== false && Boolean(this.options.fsReadHandler || this.options.cwd);
    const hasFsWrite = this.options.allowHostTools !== false && Boolean(this.options.fsWriteHandler || this.options.cwd);

    const params: InitializeRequest = {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: hasFsRead, writeTextFile: hasFsWrite },
        terminal: false,
        session: { notices: true }
      },
      clientInfo: { name: 'Causyne Agent', version: this.options.clientVersion ?? '0.0.0' }
    };

    const result = await this.request<InitializeResult>(ACP_METHODS.INITIALIZE, params, 30_000, signal);
    this.initResult = result;
    return result;
  }

  async newSession(cwd: string, mcpServers: unknown[] = [], signal?: AbortSignal): Promise<string> {
    const result = await this.request<{ sessionId?: unknown }>(ACP_METHODS.NEW_SESSION, {
      cwd,
      mcpServers
    }, 30_000, signal);
    if (!result || typeof result.sessionId !== 'string' || !result.sessionId) {
      throw new Error('agent did not return a session id');
    }
    this.recordSessionModels(result.sessionId, result);
    return result.sessionId;
  }

  async authenticate(methodId: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return await this.request<unknown>(ACP_METHODS.AUTHENTICATE, {
      methodId,
      params
    }, 30_000);
  }

  async setSessionModel(sessionId: string, modelId: string, signal?: AbortSignal): Promise<void> {
    const state = this.sessionModels.get(sessionId) ?? this.latestSessionModels;
    try {
      const res = await this.request<unknown>(ACP_METHODS.SET_MODEL, {
        sessionId,
        modelId
      }, 5_000, signal);
      this.recordSessionModels(sessionId, res);
      const updated = this.sessionModels.get(sessionId);
      if (updated) {
        updated.currentModelId = modelId;
        this.latestSessionModels = updated;
      }
      return;
    } catch (err: unknown) {
      if (signal?.aborted || (err instanceof Error && err.name === 'AbortError')) {
        throw err;
      }
      if (state.usesConfigOption) {
        const res = await this.request<unknown>(ACP_METHODS.SET_CONFIG_OPTION, {
          sessionId,
          configId: state.configOptionId || 'model',
          value: modelId
        }, 5_000, signal);
        this.recordSessionModels(sessionId, res);
        return;
      }
      throw err;
    }
  }

  async setSessionMode(sessionId: string, modeId: string): Promise<void> {
    await this.request<void>(ACP_METHODS.SET_MODE, {
      sessionId,
      modeId
    }, 30_000);
  }

  async loadSession(sessionId: string, cwd?: string): Promise<unknown> {
    const res = await this.request<unknown>(ACP_METHODS.LOAD, {
      sessionId,
      cwd: cwd || this.options.cwd
    }, 30_000);
    this.recordSessionModels(sessionId, res);
    return res;
  }

  async prompt(sessionId: string, input: string | ContentBlock[], signal?: AbortSignal): Promise<AcpPromptResult> {
    if (signal?.aborted) throw createAbortError();
    const blocks: ContentBlock[] = typeof input === 'string' ? [{ type: 'text', text: input }] : input;
    let collected = '';
    const collector = (update: SessionUpdate): void => {
      if (signal?.aborted) return;
      this.notifyPendingActivity();
      // handleLine already notifies options.onUpdate for this session. Calling
      // it again here duplicated every live chunk and file-action frame.
      if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
        collected = `${collected}${update.content.text}`.slice(0, MAX_UPDATE_CHARS);
      }
    };
    const previous = this.updateListener;
    this.updateListener = (sessionIdFromEvent, update) => {
      if (signal?.aborted) return;
      this.notifyPendingActivity();
      previous?.(sessionIdFromEvent, update);
      if (sessionIdFromEvent === sessionId) collector(update);
    };
    const onAbort = (): void => {
      try {
        this.notifyCancel(sessionId);
      } catch {
        // ignore cancel write failure
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const response = await this.request<PromptResponse>(ACP_METHODS.PROMPT, {
        sessionId,
        prompt: blocks
      }, this.options.promptTimeoutMs ?? 15 * 60 * 1000, signal, {
        sessionId,
        inactivityTimeoutMs: this.options.inactivityTimeoutMs ?? 120_000
      });
      return {
        stopReason: response?.stopReason ?? 'end_turn',
        ...(response?.usage ? { usage: response.usage } : {}),
        text: collected
      };
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.updateListener = previous;
    }
  }

  notifyCancel(sessionId: string): void {
    this.write({
      jsonrpc: '2.0',
      method: ACP_METHODS.CANCEL,
      params: { sessionId }
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const child = this.child;
    this.child = null;
    this.failAll(new Error('client closed'));
    if (!child) return;
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        done();
      }, 250);
      if (typeof timer.unref === 'function') timer.unref();
      child.once('exit', done);
      try {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      } catch {
        // ignore stream destroy errors
      }
      try {
        child.kill('SIGTERM');
      } catch {
        done();
      }
    });
  }

  private updateListener: ((sessionId: string, update: SessionUpdate) => void) | null = null;

  private write(message: JsonRpcRequest<unknown> | JsonRpcResponse | JsonRpcNotification<unknown>): void {
    if (!this.child || this.closed) return;
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch {
      // A dead pipe surfaces through the exit handler.
    }
  }

  private async drain(): Promise<void> {
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) await this.handleLine(line);
      index = this.buffer.indexOf('\n');
    }
  }

  private async handleLine(line: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
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
    const method = (parsed as { method?: unknown }).method;
    if (method === ACP_METHODS.UPDATE) {
      const params = (parsed as { params?: SessionNotification }).params;
      if (params && typeof params.sessionId === 'string' && params.update) {
        this.recordSessionModels(params.sessionId, params.update);
        this.updateListener?.(params.sessionId, params.update);
        this.options.onUpdate?.(params.sessionId, params.update);
      }
    }
  }

  private async handleServerRequest(request: JsonRpcRequest): Promise<void> {
    if (this.options.allowHostTools === false
      && (request.method === ACP_METHODS.READ_TEXT_FILE || request.method === ACP_METHODS.WRITE_TEXT_FILE)) {
      this.write({ jsonrpc: '2.0', id: request.id,
        error: { code: ACP_ERROR_CODES.INVALID_REQUEST, message: 'Use the advertised Causyne tools for host file access.' } });
      return;
    }
    if (request.method === ACP_METHODS.REQUEST_PERMISSION) {
      const handler = this.options.permissionHandler;
      if (!handler) {
        this.write({
          jsonrpc: '2.0',
          id: request.id,
          result: { outcome: { outcome: 'cancelled' } } satisfies RequestPermissionResponse
        });
        return;
      }
      try {
        const outcome = await handler(request.params as unknown as RequestPermissionRequest);
        this.write({ jsonrpc: '2.0', id: request.id, result: { outcome } });
      } catch {
        this.write({ jsonrpc: '2.0', id: request.id, result: { outcome: { outcome: 'cancelled' } } });
      }
      return;
    }

    if (request.method === ACP_METHODS.READ_TEXT_FILE) {
      const params = request.params as unknown as ReadTextFileRequest | undefined;
      const targetPath = params?.path;
      if (!targetPath || typeof targetPath !== 'string') {
        this.write({
          jsonrpc: '2.0',
          id: request.id,
          error: { code: ACP_ERROR_CODES.INVALID_PARAMS, message: 'Missing file path' }
        });
        return;
      }

      try {
        let content: string;
        if (this.options.fsReadHandler) {
          const readOpts: { line?: number; limit?: number } = {};
          if (params?.line !== undefined) readOpts.line = params.line;
          if (params?.limit !== undefined) readOpts.limit = params.limit;
          content = await this.options.fsReadHandler(targetPath, readOpts);
        } else {
          const resolved = path.resolve(this.options.cwd, targetPath);
          content = await fs.readFile(resolved, 'utf8');
        }
        this.write({
          jsonrpc: '2.0',
          id: request.id,
          result: { content } satisfies ReadTextFileResponse
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.write({
          jsonrpc: '2.0',
          id: request.id,
          error: { code: ACP_ERROR_CODES.RESOURCE_NOT_FOUND, message: `Could not read file: ${msg}` }
        });
      }
      return;
    }

    if (request.method === ACP_METHODS.WRITE_TEXT_FILE) {
      const params = request.params as unknown as WriteTextFileRequest | undefined;
      const targetPath = params?.path;
      const content = params?.content;
      if (!targetPath || typeof targetPath !== 'string' || typeof content !== 'string') {
        this.write({
          jsonrpc: '2.0',
          id: request.id,
          error: { code: ACP_ERROR_CODES.INVALID_PARAMS, message: 'Missing file path or content' }
        });
        return;
      }

      try {
        if (this.options.fsWriteHandler) {
          await this.options.fsWriteHandler(targetPath, content);
        } else {
          const resolved = path.resolve(this.options.cwd, targetPath);
          await fs.mkdir(path.dirname(resolved), { recursive: true });
          await fs.writeFile(resolved, content, 'utf8');
        }
        this.write({
          jsonrpc: '2.0',
          id: request.id,
          result: {} satisfies WriteTextFileResponse
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.write({
          jsonrpc: '2.0',
          id: request.id,
          error: { code: ACP_ERROR_CODES.INTERNAL_ERROR, message: `Could not write file: ${msg}` }
        });
      }
      return;
    }

    this.write({
      jsonrpc: '2.0',
      id: request.id,
      error: { code: ACP_ERROR_CODES.METHOD_NOT_FOUND, message: `Unsupported client method: ${request.method}` }
    });
  }

  private settle(response: JsonRpcResponse): void {
    if (response.id === null || response.id === undefined) return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    if (pending.inactivityTimer) clearTimeout(pending.inactivityTimer);
    if (pending.snifferInterval) clearInterval(pending.snifferInterval);
    pending.cleanup?.();
    this.pending.delete(response.id);
    if (response.error) {
      const err = new Error(`${pending.method} failed: ${response.error.message}`);
      (err as unknown as { code?: number }).code = response.error.code;
      (err as unknown as { data?: unknown }).data = response.error.data;
      pending.reject(err);
      return;
    }
    pending.resolve(response.result);
  }

  private notifyPendingActivity(): void {
    for (const pending of this.pending.values()) {
      pending.notifyActivity?.();
    }
  }

  inspectPeerDiagnostics(sessionId?: string): string | null {
    if (this.exitError) {
      return this.exitError.message;
    }
    if (this.child && this.child.exitCode !== null) {
      const detail = this.stderrTail.trim() || `exit code ${this.child.exitCode}`;
      return `agent process exited: ${detail}`;
    }
    if (this.stderrTail) {
      const fatalPatterns = [
        /free usage limit reached/i,
        /ai_apicallerror/i,
        /ai_retryerror/i,
        /rate limit/i,
        /quota exceeded/i,
        /insufficient_quota/i,
        /unauthorized/i,
        /authentication failed/i,
        /invalid api key/i
      ];
      for (const pat of fatalPatterns) {
        if (pat.test(this.stderrTail)) {
          const match = this.stderrTail.split('\n').find(l => pat.test(l));
          if (match) return match.trim();
        }
      }
    }
    const cmd = (this.options.command || '').toLowerCase();
    const isOpencode = cmd.includes('opencode')
      || (this.options.args && this.options.args.some(a => String(a).toLowerCase().includes('opencode')));
    if (isOpencode) {
      const opencodeErr = this.inspectOpencodeLog(sessionId);
      if (opencodeErr) return opencodeErr;
    }
    return null;
  }

  private inspectOpencodeLog(sessionId?: string): string | null {
    try {
      const logPath = path.join(os.homedir(), '.local', 'share', 'opencode', 'log', 'opencode.log');
      if (!fsSync.existsSync(logPath)) return null;
      const stat = fsSync.statSync(logPath);
      if (stat.size === 0) return null;
      const readBytes = Math.min(stat.size, 65536);
      const buffer = Buffer.alloc(readBytes);
      const fd = fsSync.openSync(logPath, 'r');
      try {
        fsSync.readSync(fd, buffer, 0, readBytes, stat.size - readBytes);
      } finally {
        fsSync.closeSync(fd);
      }
      const text = buffer.toString('utf8');
      const lines = text.split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= Math.max(0, lines.length - 60); i--) {
        const line = lines[i];
        if (!line) continue;
        if (sessionId && !line.includes(sessionId)) continue;
        if (line.includes('level=ERROR') || line.includes('AI_APICallError') || line.includes('Free usage limit reached') || line.includes('AI_RetryError')) {
          const match = line.match(/error\.error="([^"]+)"/) || line.match(/message="([^"]+)"/);
          if (match && match[1]) {
            return match[1].replace(/\\n/g, ' ').trim();
          }
          return line.trim();
        }
      }
    } catch {
      // ignore log inspection errors
    }
    return null;
  }

  private request<T>(
    method: string,
    params: unknown,
    timeoutMs: number,
    signal?: AbortSignal,
    options?: { sessionId?: string; inactivityTimeoutMs?: number }
  ): Promise<T> {
    if (signal?.aborted) return Promise.reject(createAbortError());
    if (!this.child || this.closed) return Promise.reject(new Error('agent process is not running'));
    if (this.exitError) return Promise.reject(this.exitError);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      let inactivityTimer: NodeJS.Timeout | undefined;
      let snifferInterval: NodeJS.Timeout | undefined;

      const cleanup = (): void => {
        signal?.removeEventListener('abort', onAbort);
        if (inactivityTimer) clearTimeout(inactivityTimer);
        if (snifferInterval) clearInterval(snifferInterval);
      };
      const onAbort = (): void => {
        clearTimeout(timer);
        cleanup();
        this.pending.delete(id);
        reject(createAbortError());
      };
      const timer = setTimeout(() => {
        cleanup();
        this.pending.delete(id);
        const diag = this.inspectPeerDiagnostics(options?.sessionId);
        if (diag) {
          reject(new Error(`ACP Peer Agent (${this.options.command}) Error: ${diag}`));
        } else {
          reject(new Error(`${method} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      const resetInactivity = (): void => {
        const timeoutMsInact = options?.inactivityTimeoutMs;
        if (!timeoutMsInact) return;
        if (inactivityTimer) clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(() => {
          cleanup();
          this.pending.delete(id);
          const diag = this.inspectPeerDiagnostics(options?.sessionId);
          if (diag) {
            reject(new Error(`ACP Peer Agent (${this.options.command}) Error: ${diag}`));
          } else {
            reject(new Error(`${method} stalled: no activity from peer in ${Math.round(timeoutMsInact / 1000)}s`));
          }
        }, timeoutMsInact);
        if (typeof inactivityTimer.unref === 'function') inactivityTimer.unref();
      };

      const sid = options?.sessionId;
      if (sid) {
        snifferInterval = setInterval(() => {
          const fatalDiag = this.inspectPeerDiagnostics(sid);
          if (fatalDiag) {
            cleanup();
            clearTimeout(timer);
            this.pending.delete(id);
            try { this.notifyCancel(sid); } catch { /* ignore */ }
            reject(new Error(`ACP Peer Agent (${this.options.command}) Error: ${fatalDiag}`));
          }
        }, 1500);
        if (typeof snifferInterval.unref === 'function') snifferInterval.unref();
      }

      resetInactivity();
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
        inactivityTimer,
        snifferInterval,
        method,
        cleanup,
        notifyActivity: resetInactivity
      });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  private failAll(error: Error): void {
    this.exitError = error;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      if (pending.inactivityTimer) clearTimeout(pending.inactivityTimer);
      if (pending.snifferInterval) clearInterval(pending.snifferInterval);
      pending.cleanup?.();
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
