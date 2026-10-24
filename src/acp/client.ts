import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  ACP_ERROR_CODES,
  ACP_METHODS,
  ACP_PROTOCOL_VERSION,
  isJsonRpcRequest,
  isJsonRpcResponse
} from './protocol.js';
import type {
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
  permissionHandler?: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse['outcome']>;
  onUpdate?: (sessionId: string, update: SessionUpdate) => void;
  fsReadHandler?: (filePath: string, options?: { line?: number; limit?: number }) => Promise<string>;
  fsWriteHandler?: (filePath: string, content: string) => Promise<void>;
}

export interface AcpPromptResult {
  stopReason: PromptResponse['stopReason'];
  text: string;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
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

  async start(): Promise<InitializeResult> {
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
      this.buffer += chunk;
      void this.drain();
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-MAX_STDERR_CHARS);
    });
    child.on('error', (error) => this.failAll(new Error(`agent process failed: ${error.message}`)));
    child.on('exit', (code, signal) => {
      const detail = this.stderrTail.trim() || `exit code ${code ?? 'null'}${signal ? ` signal ${signal}` : ''}`;
      this.failAll(new Error(`agent process exited: ${detail}`));
    });

    const hasFsRead = Boolean(this.options.fsReadHandler || this.options.cwd);
    const hasFsWrite = Boolean(this.options.fsWriteHandler || this.options.cwd);

    const params: InitializeRequest = {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: hasFsRead, writeTextFile: hasFsWrite },
        terminal: false,
        session: { notices: true }
      },
      clientInfo: { name: 'Causyne Agent', version: this.options.clientVersion ?? '0.0.0' }
    };

    const result = await this.request<InitializeResult>(ACP_METHODS.INITIALIZE, params, 30_000);
    this.initResult = result;
    return result;
  }

  async newSession(cwd: string, mcpServers: unknown[] = []): Promise<string> {
    const result = await this.request<{ sessionId?: unknown }>(ACP_METHODS.NEW_SESSION, {
      cwd,
      mcpServers
    }, 30_000);
    if (!result || typeof result.sessionId !== 'string' || !result.sessionId) {
      throw new Error('agent did not return a session id');
    }
    return result.sessionId;
  }

  async authenticate(methodId: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return await this.request<unknown>(ACP_METHODS.AUTHENTICATE, {
      methodId,
      params
    }, 30_000);
  }

  async setSessionModel(sessionId: string, modelId: string): Promise<void> {
    await this.request<void>(ACP_METHODS.SET_MODEL, {
      sessionId,
      modelId
    }, 30_000);
  }

  async setSessionMode(sessionId: string, modeId: string): Promise<void> {
    await this.request<void>(ACP_METHODS.SET_MODE, {
      sessionId,
      modeId
    }, 30_000);
  }

  async loadSession(sessionId: string, cwd?: string): Promise<unknown> {
    return await this.request<unknown>(ACP_METHODS.LOAD, {
      sessionId,
      cwd: cwd || this.options.cwd
    }, 30_000);
  }

  async prompt(sessionId: string, input: string | ContentBlock[]): Promise<AcpPromptResult> {
    const blocks: ContentBlock[] = typeof input === 'string' ? [{ type: 'text', text: input }] : input;
    let collected = '';
    const collector = (update: SessionUpdate): void => {
      // handleLine already notifies options.onUpdate for this session. Calling
      // it again here duplicated every live chunk and file-action frame.
      if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
        collected = `${collected}${update.content.text}`.slice(0, MAX_UPDATE_CHARS);
      }
    };
    const previous = this.updateListener;
    this.updateListener = (sessionIdFromEvent, update) => {
      previous?.(sessionIdFromEvent, update);
      if (sessionIdFromEvent === sessionId) collector(update);
    };
    try {
      const response = await this.request<PromptResponse>(ACP_METHODS.PROMPT, {
        sessionId,
        prompt: blocks
      }, this.options.promptTimeoutMs ?? 15 * 60 * 1000);
      return {
        stopReason: response?.stopReason ?? 'end_turn',
        text: collected
      };
    } finally {
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
    this.failAll(new Error('client closed'));
    if (!child) return;
    await new Promise<void>((resolve) => {
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
        this.updateListener?.(params.sessionId, params.update);
        this.options.onUpdate?.(params.sessionId, params.update);
      }
    }
  }

  private async handleServerRequest(request: JsonRpcRequest): Promise<void> {
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

  private request<T>(method: string, params: unknown, timeoutMs: number): Promise<T> {
    if (!this.child || this.closed) return Promise.reject(new Error('agent process is not running'));
    if (this.exitError) return Promise.reject(this.exitError);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
        method
      });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  private failAll(error: Error): void {
    this.exitError = error;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
