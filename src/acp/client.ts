import { spawn, spawnSync } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isPhysicalPathAllowed } from '../agent/workspaceBoundary.js';
import { isCredentialPath } from '../sandbox.js';
import { redactProviderSecrets } from '../providers/byokHttp.js';
import { resolveWindowsSpawnTarget } from '../utils/winSpawn.js';
import {
  ACP_ERROR_CODES,
  ACP_METHODS,
  ACP_PROTOCOL_VERSION,
  extractAcpSessionModels,
  isJsonRpcRequest,
  isJsonRpcResponse,
  isJsonRpcNotification
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
const MAX_HOST_FILE_BYTES = 4 * 1024 * 1024;
const MAX_JSONRPC_BUFFER_BYTES = 16 * 1024 * 1024;
const MAX_TRACKED_SESSIONS = 128;
const MAX_OPEN_TOOL_CALLS = 512;

export class AcpClient {
  private readonly options: AcpClientOptions;
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private draining = false;
  private stderrTail = '';
  private readonly pending = new Map<string | number, PendingRequest>();
  private readonly openToolCalls = new Map<string, number>();
  private activePermissionRequests = 0;
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
    if (!this.sessionModels.has(sessionId) && this.sessionModels.size >= MAX_TRACKED_SESSIONS) {
      const oldest = this.sessionModels.keys().next().value;
      if (oldest !== undefined) this.sessionModels.delete(oldest);
    }
    this.sessionModels.set(sessionId, merged);
    this.latestSessionModels = merged;
  }

  async start(signal?: AbortSignal): Promise<InitializeResult> {
    if (signal?.aborted) throw createAbortError();
    if (this.closed) throw new Error('ACP client is closed');
    if (this.child) throw new Error('client already started');
    const args = this.options.args ?? [];
    const childEnv: NodeJS.ProcessEnv = this.options.env ? { ...this.options.env } : { ...process.env };
    delete childEnv.CAUSYNE_VAULT_KEY;
    delete childEnv.CAUSYNE_DEV_SECRET;
    delete childEnv.CAUSYNE_DEV_TOKEN;
    const isPosix = process.platform !== 'win32';
    const spawnTarget = resolveWindowsSpawnTarget(this.options.command, args, { env: childEnv });
    const child = spawn(spawnTarget.command, spawnTarget.args, {
      cwd: this.options.cwd,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: isPosix,
      windowsHide: true
    });
    this.child = child;
    child.stdin.on('error', (error) => {
      if (!this.closed) this.failAll(error);
    });

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (this.closed || this.exitError) return;
      this.buffer += chunk;
      if (this.buffer.length > MAX_JSONRPC_BUFFER_BYTES) {
        this.buffer = '';
        this.failAll(new Error('agent output frame exceeded maximum size'));
        return;
      }
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
      const cleanTail = redactProviderSecrets(this.stderrTail).trim();
      const detail = cleanTail || `exit code ${code ?? 'null'}${exitSignal ? ` signal ${exitSignal}` : ''}`;
      this.failAll(new Error(`agent process exited: ${detail}`));
    });

    const hasFsRead = this.options.allowHostTools !== false && Boolean(this.options.fsReadHandler || this.options.cwd);
    const hasFsWrite = this.options.allowHostTools !== false && Boolean(this.options.fsWriteHandler || this.options.cwd);

    const params: InitializeRequest = {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: hasFsRead, writeTextFile: hasFsWrite },
        terminal: false,
        _meta: { session: { notices: true } }
      },
      clientInfo: { name: 'Causyne Agent', version: this.options.clientVersion ?? '0.0.0' }
    };

    try {
      const result = await this.request<InitializeResult>(ACP_METHODS.INITIALIZE, params, 30_000, signal);
      this.initResult = result;
      return result;
    } catch (err) {
      await this.close().catch(() => {});
      throw err;
    }
  }

  async newSession(cwd: string, mcpServers: unknown[] = [], signal?: AbortSignal): Promise<string> {
    if (typeof cwd !== 'string' || !cwd.trim() || cwd.includes('\0')) {
      throw new Error('newSession requires a valid cwd');
    }
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

  async authenticate(methodId: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<unknown> {
    if (typeof methodId !== 'string' || !methodId.trim()) {
      throw new Error('authenticate requires a non-empty methodId');
    }
    return await this.request<unknown>(ACP_METHODS.AUTHENTICATE, {
      methodId: methodId.trim(),
      params
    }, 30_000, signal);
  }

  async setSessionModel(sessionId: string, modelId: string, signal?: AbortSignal): Promise<void> {
    if (typeof sessionId !== 'string' || !sessionId.trim() || typeof modelId !== 'string' || !modelId.trim()) {
      throw new Error('setSessionModel requires non-empty sessionId and modelId');
    }
    const state = this.sessionModels.get(sessionId) ?? this.latestSessionModels;
    try {
      const res = await this.request<unknown>(ACP_METHODS.SET_MODEL, {
        sessionId,
        modelId
      }, 20_000, signal);
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
        }, 20_000, signal);
        this.recordSessionModels(sessionId, res);
        return;
      }
      throw err;
    }
  }

  async setSessionMode(sessionId: string, modeId: string, signal?: AbortSignal): Promise<void> {
    if (typeof sessionId !== 'string' || !sessionId.trim() || typeof modeId !== 'string' || !modeId.trim()) {
      throw new Error('setSessionMode requires non-empty sessionId and modeId');
    }
    await this.request<void>(ACP_METHODS.SET_MODE, {
      sessionId,
      modeId
    }, 30_000, signal);
  }

  async loadSession(sessionId: string, cwd?: string, signal?: AbortSignal): Promise<unknown> {
    if (typeof sessionId !== 'string' || !sessionId.trim()) {
      throw new Error('loadSession requires a non-empty sessionId');
    }
    const res = await this.request<unknown>(ACP_METHODS.LOAD, {
      sessionId,
      cwd: cwd || this.options.cwd
    }, 30_000, signal);
    this.recordSessionModels(sessionId, res);
    return res;
  }

  async prompt(sessionId: string, input: string | ContentBlock[], signal?: AbortSignal): Promise<AcpPromptResult> {
    if (signal?.aborted) throw createAbortError();
    if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.includes('\0')) throw new Error('ACP prompt requires a valid session ID');
    if (this.promptActive) throw new Error('ACP client already has an active prompt');
    this.promptActive = sessionId;
    this.promptGeneration++;
    // Diagnostic text from an earlier turn must not cancel this prompt.
    this.stderrTail = '';
    const blocks: ContentBlock[] = typeof input === 'string' ? [{ type: 'text', text: input }] : input;
    let collected = '';
    const collector = (update: SessionUpdate): void => {
      if (signal?.aborted) return;
      this.notifyPendingActivity();
      // handleLine already notifies options.onUpdate for this session. Calling
      // it again here duplicated every live chunk and file-action frame.
      if (
        update.sessionUpdate === 'agent_message_chunk' &&
        update.content !== null &&
        typeof update.content === 'object' &&
        update.content.type === 'text' &&
        typeof update.content.text === 'string'
      ) {
        collected = `${collected}${update.content.text}`.slice(0, MAX_UPDATE_CHARS);
      }
    };
    const listener = (sessionIdFromEvent: string, update: SessionUpdate): void => {
      if (signal?.aborted) return;
      this.notifyPendingActivity();
      if (sessionIdFromEvent === sessionId) collector(update);
    };
    this.updateListeners.add(listener);
    const onAbort = (): void => {
      try {
        this.notifyCancel(sessionId);
      } catch {
        // ignore cancel write failure
      }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const rawPromptTimeout = this.options.promptTimeoutMs;
      const promptTimeoutMs = typeof rawPromptTimeout === 'number' && Number.isFinite(rawPromptTimeout) && rawPromptTimeout > 0
        ? Math.max(10, Math.min(3_600_000, Math.round(rawPromptTimeout)))
        : 15 * 60 * 1000;
      const rawInactivityTimeout = this.options.inactivityTimeoutMs;
      const inactivityTimeoutMs = typeof rawInactivityTimeout === 'number' && Number.isFinite(rawInactivityTimeout) && rawInactivityTimeout > 0
        ? Math.max(10, Math.min(3_600_000, Math.round(rawInactivityTimeout)))
        : 120_000;
      const response = await this.request<PromptResponse>(ACP_METHODS.PROMPT, {
        sessionId,
        prompt: blocks
      }, promptTimeoutMs, signal, {
        sessionId,
        inactivityTimeoutMs
      });
      if (!response || !['end_turn', 'max_tokens', 'max_turn_requests', 'refusal', 'cancelled'].includes(response.stopReason)) {
        throw new Error('ACP peer returned an invalid prompt stop reason');
      }
      return {
        stopReason: response.stopReason,
        ...(response?.usage ? { usage: response.usage } : {}),
        text: collected
      };
    } finally {
      signal?.removeEventListener('abort', onAbort);
      this.updateListeners.delete(listener);
      this.promptActive = null;
      this.clearOpenToolCalls(sessionId);
    }
  }

  /**
   * Track peer-native tool calls that are still running.
   *
   * A peer executing a long native command (build, install, decompile) may send
   * no session updates until the command finishes. That silence is work, not a
   * stall, so the inactivity guard re-arms while such a call is open. The hard
   * prompt timeout still bounds the whole turn.
   */
  private trackToolCall(sessionId: string, update: SessionUpdate): void {
    const record = update as unknown as { sessionUpdate?: unknown; toolCallId?: unknown; status?: unknown };
    if (record.sessionUpdate !== 'tool_call' && record.sessionUpdate !== 'tool_call_update') return;
    if (typeof record.toolCallId !== 'string' || !record.toolCallId) return;
    const key = `${sessionId}\u0000${record.toolCallId}`;
    const status = typeof record.status === 'string' ? record.status : '';
    if (status === 'completed' || status === 'failed' || status === 'cancelled') {
      this.openToolCalls.delete(key);
    } else if (record.sessionUpdate === 'tool_call' || status === 'pending' || status === 'in_progress' || status === 'running') {
      if (!this.openToolCalls.has(key)) {
        if (this.openToolCalls.size >= MAX_OPEN_TOOL_CALLS) {
          const oldest = this.openToolCalls.keys().next().value;
          if (oldest !== undefined) this.openToolCalls.delete(oldest);
        }
        this.openToolCalls.set(key, Date.now());
      }
    }
  }

  private clearOpenToolCalls(sessionId: string): void {
    const prefix = `${sessionId}\u0000`;
    for (const key of this.openToolCalls.keys()) {
      if (key.startsWith(prefix)) this.openToolCalls.delete(key);
    }
  }

  private hasOpenToolCall(sessionId?: string, maxSilenceMs = 10 * 60 * 1000): boolean {
    if (!sessionId || !this.child || this.child.exitCode !== null || this.closed) return false;
    const prefix = `${sessionId}\u0000`;
    const now = Date.now();
    for (const [key, startedAt] of this.openToolCalls.entries()) {
      if (key.startsWith(prefix) && now - startedAt < maxSilenceMs) return true;
    }
    return false;
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
    this.buffer = '';
    this.openToolCalls.clear();
    this.updateListeners.clear();
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
      const terminateTree = (sig: 'SIGTERM' | 'SIGKILL'): void => {
        const pid = child.pid;
        if (process.platform === 'win32' && pid) {
          try {
            spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 2000, windowsHide: true });
            return;
          } catch { /* fallback to child.kill */ }
        } else if (process.platform !== 'win32' && pid) {
          try {
            process.kill(-pid, sig);
            return;
          } catch { /* fallback to direct child.kill */ }
        }
        try { child.kill(sig); } catch { /* ignore */ }
      };
      const timer = setTimeout(() => {
        terminateTree('SIGKILL');
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
        terminateTree('SIGTERM');
      } catch {
        done();
      }
    });
  }

  private promptActive: string | null = null;
  private promptGeneration = 0;
  private readonly updateListeners = new Set<(sessionId: string, update: SessionUpdate) => void>();

  private write(message: JsonRpcRequest<unknown> | JsonRpcResponse | JsonRpcNotification<unknown>): void {
    if (!this.child || this.closed || this.exitError) return;
    try {
      this.child.stdin.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this.failAll(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private drain(): void {
    if (this.draining) return;
    this.draining = true;
    try {
      let index = this.buffer.indexOf('\n');
      while (index >= 0 && !this.closed && !this.exitError) {
        const line = this.buffer.slice(0, index).replace(/^\uFEFF/, '').trim();
        this.buffer = this.buffer.slice(index + 1);
        if (line) {
          try { this.handleLine(line); } catch (error) {
            this.failAll(error instanceof Error ? error : new Error(String(error)));
          }
        }
        index = this.buffer.indexOf('\n');
      }
    } finally {
      this.draining = false;
    }
  }

  private handleLine(line: string): void {
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
      // Dispatch server requests concurrently so waiting on HITL permission or
      // host I/O never head-of-line blocks subsequent updates or responses.
      void this.handleServerRequest(parsed).catch(() => {});
      return;
    }
    if (!isJsonRpcNotification(parsed)) return;
    const method = parsed.method;
    if (method === ACP_METHODS.UPDATE) {
      const params = parsed.params as unknown as SessionNotification | undefined;
      if (
        params &&
        typeof params.sessionId === 'string' &&
        params.update !== null &&
        typeof params.update === 'object' &&
        !Array.isArray(params.update)
      ) {
        if (this.promptActive && params.sessionId !== this.promptActive) return;
        this.recordSessionModels(params.sessionId, params.update);
        this.trackToolCall(params.sessionId, params.update);
        for (const listener of [...this.updateListeners]) {
          listener(params.sessionId, params.update);
        }
        this.options.onUpdate?.(params.sessionId, params.update);
      }
    }
  }

  private async handleServerRequest(request: JsonRpcRequest): Promise<void> {
    if ((request.method === ACP_METHODS.READ_TEXT_FILE || request.method === ACP_METHODS.WRITE_TEXT_FILE)
      && (!this.promptActive || (request.params as { sessionId?: unknown } | undefined)?.sessionId !== this.promptActive)) {
      this.write({ jsonrpc: '2.0', id: request.id, error: { code: ACP_ERROR_CODES.INVALID_REQUEST, message: 'Host file request does not belong to the active session' } });
      return;
    }
    if (this.options.allowHostTools === false
      && (request.method === ACP_METHODS.READ_TEXT_FILE || request.method === ACP_METHODS.WRITE_TEXT_FILE)) {
      this.write({ jsonrpc: '2.0', id: request.id,
        error: { code: ACP_ERROR_CODES.INVALID_REQUEST, message: 'Use the advertised Causyne tools for host file access.' } });
      return;
    }
    if (request.method === ACP_METHODS.REQUEST_PERMISSION) {
      const handler = this.options.permissionHandler;
      if (!handler || !this.promptActive || (request.params as { sessionId?: unknown } | undefined)?.sessionId !== this.promptActive) {
        this.write({
          jsonrpc: '2.0',
          id: request.id,
          result: { outcome: { outcome: 'cancelled' } } satisfies RequestPermissionResponse
        });
        return;
      }
      this.activePermissionRequests++;
      try {
        const permission = request.params as unknown as RequestPermissionRequest;
        const activePrompt = this.promptActive;
        const generation = this.promptGeneration;
        const options = Array.isArray(permission.options) ? permission.options : [];
        if (!permission.toolCall || typeof permission.toolCall.toolCallId !== 'string' || !permission.toolCall.toolCallId || !options.length) {
          throw new Error('Invalid peer permission request');
        }
        const rawOutcome = await handler(permission);
        const validOutcome: RequestPermissionResponse['outcome'] =
          activePrompt !== null && this.promptActive === activePrompt && this.promptGeneration === generation && !this.closed && rawOutcome && typeof rawOutcome === 'object' && rawOutcome.outcome === 'selected' && typeof rawOutcome.optionId === 'string' && options.some(option => option?.optionId === rawOutcome.optionId)
            ? { outcome: 'selected', optionId: rawOutcome.optionId }
            : { outcome: 'cancelled' };
        this.write({ jsonrpc: '2.0', id: request.id, result: { outcome: validOutcome } });
      } catch {
        this.write({ jsonrpc: '2.0', id: request.id, result: { outcome: { outcome: 'cancelled' } } });
      } finally {
        this.activePermissionRequests = Math.max(0, this.activePermissionRequests - 1);
        this.notifyPendingActivity();
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
          if (targetPath.includes('\0')) {
            throw new Error('File path contains invalid NUL byte');
          }
          const resolved = path.resolve(this.options.cwd, targetPath);
          if (!isPhysicalPathAllowed(resolved, [this.options.cwd], false)) {
            throw new Error('File path is outside the allowed workspace');
          }
          if (isCredentialPath(resolved)) {
            throw new Error('Reading credential files via ACP host bridge is prohibited');
          }
          const stat = await fs.lstat(resolved);
          if (stat.isSymbolicLink() || !stat.isFile()) {
            throw new Error('Refusing to read symlink or non-regular file');
          }
          if (stat.size > MAX_HOST_FILE_BYTES) {
            throw new Error(`File exceeds maximum readable size (${MAX_HOST_FILE_BYTES} bytes)`);
          }
          const rawContent = await fs.readFile(resolved, 'utf8');
          if (typeof params?.line === 'number' || typeof params?.limit === 'number') {
            const lines = rawContent.split(/\r?\n/);
            const start = typeof params?.line === 'number' && Number.isFinite(params.line)
              ? Math.max(0, Math.floor(params.line) - 1)
              : 0;
            const count = typeof params?.limit === 'number' && Number.isFinite(params.limit) && params.limit > 0
              ? Math.floor(params.limit)
              : lines.length;
            content = lines.slice(start, start + count).join('\n');
          } else {
            content = rawContent;
          }
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
          if (targetPath.includes('\0')) {
            throw new Error('File path contains invalid NUL byte');
          }
          if (Buffer.byteLength(content, 'utf8') > MAX_HOST_FILE_BYTES) {
            throw new Error(`File content exceeds maximum writable size (${MAX_HOST_FILE_BYTES} bytes)`);
          }
          const resolved = path.resolve(this.options.cwd, targetPath);
          if (!isPhysicalPathAllowed(resolved, [this.options.cwd], false)) {
            throw new Error('File path is outside the allowed workspace');
          }
          if (isCredentialPath(resolved)) {
            throw new Error('Writing credential files via ACP host bridge is prohibited');
          }
          try {
            const existing = await fs.lstat(resolved);
            if (existing.isSymbolicLink() || !existing.isFile()) {
              throw new Error('Refusing to overwrite symlink or non-regular file');
            }
          } catch (statErr: unknown) {
            const code = typeof statErr === 'object' && statErr !== null && 'code' in statErr ? String(statErr.code) : '';
            if (code !== 'ENOENT') throw statErr;
          }
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
      let detail = redactProviderSecrets(String(response.error.message || 'Unknown ACP error')).trim();
      const rawData = response.error.data;
      if (rawData !== undefined && rawData !== null) {
        const dataText = typeof rawData === 'string'
          ? rawData.trim()
          : (typeof rawData === 'object' && 'details' in rawData && typeof (rawData as { details?: unknown }).details === 'string'
              ? (rawData as { details: string }).details.trim()
              : (typeof rawData === 'object' && 'message' in rawData && typeof (rawData as { message?: unknown }).message === 'string'
                  ? (rawData as { message: string }).message.trim()
                  : (() => { try { return JSON.stringify(rawData); } catch { return ''; } })()));
        const cleanData = redactProviderSecrets(dataText).slice(0, 600).trim();
        if (cleanData && !detail.includes(cleanData)) {
          detail = `${detail} (${cleanData})`;
        }
      }
      const isGenericInternal = response.error.code === ACP_ERROR_CODES.INTERNAL_ERROR || /^internal error$/i.test(String(response.error.message || '').trim());
      if (isGenericInternal && this.stderrTail.trim()) {
        const tailLines = redactProviderSecrets(this.stderrTail).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        const stderrSummary = tailLines.slice(-4).join(' | ').slice(0, 500);
        if (stderrSummary && !detail.includes(stderrSummary)) {
          detail = `${detail} — stderr: ${stderrSummary}`;
        }
      }
      const err = new Error(`${pending.method} failed: ${detail}`);
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

  inspectPeerDiagnostics(sessionId?: string, sinceEpochMs?: number, terminalOnly = false): string | null {
    if (this.exitError) {
      return redactProviderSecrets(this.exitError.message);
    }
    if (this.child && this.child.exitCode !== null) {
      const detail = redactProviderSecrets(this.stderrTail).trim() || `exit code ${this.child.exitCode}`;
      return `agent process exited: ${detail}`;
    }
    if (this.stderrTail) {
      const terminal = /free usage limit reached|insufficient_quota|quota exceeded|invalid api key|authentication failed|credit balance is too low|unauthorized/i;
      const diagnostic = /ai_apicallerror|ai_retryerror|rate limit|cannot connect to api|socket connection was closed/i;
      const lines = this.stderrTail.split('\n').reverse();
      const match = lines.find(line => terminal.test(line) || (!terminalOnly && diagnostic.test(line)));
      if (match) return redactProviderSecrets(match).trim();
    }
    // A shared log may contain recoverable or stale errors. Only inspect it
    // for diagnostics after the normal prompt deadline, never to cancel live work.
    if (terminalOnly) return null;
    const cmd = (this.options.command || '').toLowerCase();
    const isOpencode = cmd.includes('opencode')
      || (this.options.args && this.options.args.some(a => String(a).toLowerCase().includes('opencode')));
    if (isOpencode) {
      const opencodeErr = this.inspectOpencodeLog(sessionId, sinceEpochMs);
      if (opencodeErr) return opencodeErr;
    }
    return null;
  }

  private lastOpencodeLogSignature = '';
  private lastOpencodeLogResult: string | null = null;

  private inspectOpencodeLog(sessionId?: string, sinceEpochMs?: number): string | null {
    try {
      const home = os.homedir();
      if (!home) return null;
      const xdgData = typeof process.env.XDG_DATA_HOME === 'string' && process.env.XDG_DATA_HOME.trim()
        ? process.env.XDG_DATA_HOME.trim()
        : path.join(home, '.local', 'share');
      const logPath = path.join(xdgData, 'opencode', 'log', 'opencode.log');
      if (!fsSync.existsSync(logPath)) return null;
      const stat = fsSync.lstatSync(logPath);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size === 0) return null;
      const sig = `${logPath}|${stat.mtimeMs}|${stat.size}|${sessionId || ''}|${sinceEpochMs ?? ''}`;
      if (sig === this.lastOpencodeLogSignature) {
        return this.lastOpencodeLogResult;
      }
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
      let found: string | null = null;
      for (let i = lines.length - 1; i >= Math.max(0, lines.length - 60); i--) {
        const line = lines[i];
        if (!line) continue;
        if (sessionId && !line.includes(sessionId)) continue;
        // Ignore normal stream cancellations triggered by session/cancel after <tool_call> detection
        if (/\berror=Aborted\b|\bAbortError\b|\bMessageAbortedError\b/i.test(line)) {
          continue;
        }
        if (sinceEpochMs !== undefined) {
          const tsMatch = line.match(/timestamp=([^\s]+)/);
          if (tsMatch?.[1]) {
            const lineEpochMs = Date.parse(tsMatch[1]);
            if (Number.isFinite(lineEpochMs) && lineEpochMs < sinceEpochMs - 250) {
              continue;
            }
          }
        }
        if (line.includes('level=ERROR') || line.includes('AI_APICallError') || line.includes('Free usage limit reached') || line.includes('AI_RetryError')) {
          const match = line.match(/error\.error="([^"]+)"/) || line.match(/message="([^"]+)"/);
          if (match && match[1]) {
            found = redactProviderSecrets(match[1].replace(/\\n/g, ' ')).trim();
          } else {
            found = redactProviderSecrets(line).trim();
          }
          break;
        }
      }
      this.lastOpencodeLogSignature = sig;
      this.lastOpencodeLogResult = found;
      return found;
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
    const requestStartMs = Date.now();
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let inactivityTimer: NodeJS.Timeout | undefined;
      let snifferInterval: NodeJS.Timeout | undefined;

      const cleanup = (): void => {
        signal?.removeEventListener('abort', onAbort);
        if (inactivityTimer) {
          clearTimeout(inactivityTimer);
          inactivityTimer = undefined;
        }
        if (snifferInterval) {
          clearInterval(snifferInterval);
          snifferInterval = undefined;
        }
      };
      const settleResolve = (value: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        this.pending.delete(id);
        resolve(value as T);
      };
      const settleReject = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cleanup();
        this.pending.delete(id);
        reject(error);
      };
      const onAbort = (): void => {
        settleReject(createAbortError());
      };
      const timer = setTimeout(() => {
        if (options?.sessionId) this.notifyCancel(options.sessionId);
        const diag = this.inspectPeerDiagnostics(options?.sessionId, requestStartMs);
        if (diag) {
          settleReject(new Error(`ACP Peer Agent (${this.options.command}) Error: ${diag}`));
        } else {
          settleReject(new Error(`${method} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();

      const resetInactivity = (): void => {
        if (settled) return;
        const timeoutMsInact = options?.inactivityTimeoutMs;
        if (!timeoutMsInact) return;
        if (inactivityTimer) clearTimeout(inactivityTimer);
        inactivityTimer = setTimeout(() => {
          if (settled) return;
          if (this.activePermissionRequests > 0) {
            resetInactivity();
            return;
          }
          const maxToolSilenceMs = Math.min(10 * 60 * 1000, Math.max(timeoutMsInact * 3, 300_000));
          if (this.hasOpenToolCall(options?.sessionId, maxToolSilenceMs) && !this.inspectPeerDiagnostics(options?.sessionId, requestStartMs, true)) {
            resetInactivity();
            return;
          }
          const diag = this.inspectPeerDiagnostics(options?.sessionId, requestStartMs);
          if (diag) {
            settleReject(new Error(`ACP Peer Agent (${this.options.command}) Error: ${diag}`));
          } else {
            settleReject(new Error(`${method} stalled: no activity from peer in ${Math.round(timeoutMsInact / 1000)}s`));
          }
        }, timeoutMsInact);
        if (typeof inactivityTimer.unref === 'function') inactivityTimer.unref();
        const entry = this.pending.get(id);
        if (entry) entry.inactivityTimer = inactivityTimer;
      };

      const sid = options?.sessionId;
      if (sid) {
        snifferInterval = setInterval(() => {
          if (settled) return;
          const fatalDiag = this.inspectPeerDiagnostics(sid, requestStartMs, true);
          if (fatalDiag) {
            try { this.notifyCancel(sid); } catch { /* ignore */ }
            settleReject(new Error(`ACP Peer Agent (${this.options.command}) Error: ${fatalDiag}`));
          }
        }, 1500);
        if (typeof snifferInterval.unref === 'function') snifferInterval.unref();
      }

      resetInactivity();
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, {
        resolve: settleResolve,
        reject: settleReject,
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
    this.exitError ??= error;
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
