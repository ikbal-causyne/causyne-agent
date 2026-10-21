import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AgentLoop } from '../agentLoop.js';
import type { AgentLoopEvent } from '../agentLoop.js';
import {
  ACP_ERROR_CODES,
  ACP_METHODS,
  ACP_PROTOCOL_VERSION,
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse
} from './protocol.js';
import type {
  AgentCapabilities,
  CancelNotification,
  CloseSessionRequest,
  ContentBlock,
  InitializeRequest,
  InitializeResult,
  JsonRpcError,
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  NewSessionRequest,
  NewSessionResponse,
  PermissionOption,
  PromptRequest,
  PromptResponse,
  RequestPermissionResponse,
  SessionInfo,
  SessionModeState,
  SessionNotification,
  SessionUpdate,
  SetSessionModeRequest,
  StopReason,
  ToolCall,
  ToolCallStatus,
  ToolKind
} from './protocol.js';

export interface AcpEventSink {
  readyState: number;
  send(payload: string): void;
}

export interface AcpLoopFactoryParams {
  sessionId: string;
  taskId: string;
  userPrompt: string;
  cwd: string;
  sink: AcpEventSink;
}

export type AcpLoopFactory = (params: AcpLoopFactoryParams) => AgentLoop;

export interface AcpServerOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  loopFactory?: AcpLoopFactory;
  agentName?: string;
  agentVersion?: string;
  permissionTimeoutMs?: number;
}

interface PendingClientRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface AcpSession {
  id: string;
  cwd: string;
  modeId: string;
  loop: AgentLoop | null;
  busy: boolean;
  cancelled: boolean;
  updatedAt: number;
  queue: Promise<unknown>;
}

const MODE_TO_AUTONOMY: Record<string, 'A' | 'B' | 'C'> = {
  autonomous: 'A',
  standard: 'B',
  supervised: 'C'
};

const MODES: SessionModeState = {
  currentModeId: 'standard',
  availableModes: [
    { id: 'autonomous', name: 'Autonomous', description: 'Runs without pausing for routine approvals' },
    { id: 'standard', name: 'Standard', description: 'Asks before dangerous actions' },
    { id: 'supervised', name: 'Supervised', description: 'Asks before most mutating actions' }
  ]
};

const MAX_PROMPT_CHARS = 200_000;
const MAX_RAW_CHARS = 4000;

function textFromPrompt(prompt: ContentBlock[]): string | null {
  const parts: string[] = [];
  for (const block of prompt) {
    if (block.type !== 'text') return null;
    parts.push(block.text);
  }
  return parts.join('\n').slice(0, MAX_PROMPT_CHARS);
}

function toolKind(name: string): ToolKind {
  if (/^(fs_read|read_file|read|fs_list|list_dir|view_file)$/.test(name)) return 'read';
  if (/^(fs_write|fs_edit|MultiEdit|write_file|edit_file)$/.test(name)) return 'edit';
  if (/^(fs_delete|delete_file)$/.test(name)) return 'delete';
  if (/^(fs_move|move_file)$/.test(name)) return 'move';
  if (/^(grep|glob|search|find|code_search)$/.test(name)) return 'search';
  if (/^(sysRun|sysRunBg|shell|terminal|terminal_persistent_shell|gitOp|proc_term)$/.test(name)) return 'execute';
  if (/^(webFetch|webSearch|web_fetch|web_search)$/.test(name)) return 'fetch';
  if (/^(request_decision|update_plan|think)$/.test(name)) return 'think';
  return 'other';
}

function bounded(value: unknown, limit = MAX_RAW_CHARS): string {
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  } catch {
    text = '[unserializable]';
  }
  return text.length > limit ? `${text.slice(0, limit)}…[truncated]` : text;
}

function toolTitle(name: string, args: Record<string, unknown>): string {
  const detail = args.path || args.file_path || args.command || args.cmd || args.query || args.url || args.action;
  const suffix = typeof detail === 'string' && detail.trim() ? ` ${detail.trim()}` : '';
  const title = `${name}${suffix}`;
  return title.length > 200 ? `${title.slice(0, 200)}…` : title;
}

export class AcpServer {
  private readonly input: NodeJS.ReadableStream | null;
  private readonly output: NodeJS.WritableStream | null;
  private readonly loopFactory: AcpLoopFactory | null;
  private readonly agentName: string;
  private readonly agentVersion: string;
  private readonly permissionTimeoutMs: number;
  private readonly sessions = new Map<string, AcpSession>();
  private readonly pending = new Map<string | number, PendingClientRequest>();
  private nextClientRequestId = 1;
  private buffer = '';
  private closed = false;
  private workspaceRoot: string | null = null;
  private dataListener: ((chunk: Buffer | string) => void) | null = null;
  private endListener: (() => void) | null = null;
  private errorListener: ((error: Error) => void) | null = null;

  constructor(options: AcpServerOptions = {}) {
    this.input = options.input ?? null;
    this.output = options.output ?? null;
    this.loopFactory = options.loopFactory ?? null;
    this.agentName = options.agentName ?? 'Causyne Agent';
    this.agentVersion = options.agentVersion ?? '0.0.0';
    this.permissionTimeoutMs = options.permissionTimeoutMs ?? 10 * 60 * 1000;
  }

  start(): void {
    if (!this.input || this.dataListener) return;
    this.dataListener = (chunk: Buffer | string) => {
      this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      void this.drainBuffer();
    };
    this.endListener = () => { void this.stop(); };
    this.errorListener = () => { void this.stop(); };
    this.input.on('data', this.dataListener);
    this.input.on('end', this.endListener);
    this.input.on('error', this.errorListener);
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.input && this.dataListener) this.input.off('data', this.dataListener);
    if (this.input && this.endListener) this.input.off('end', this.endListener);
    if (this.input && this.errorListener) this.input.off('error', this.errorListener);
    for (const session of this.sessions.values()) {
      try {
        session.loop?.abort();
      } catch {
        // Shutdown never blocks on a misbehaving tool.
      }
    }
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('server stopped'));
      this.pending.delete(id);
    }
  }

  private async drainBuffer(): Promise<void> {
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) await this.handleLine(line);
      index = this.buffer.indexOf('\n');
    }
  }

  async handleLine(line: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.write({ jsonrpc: '2.0', id: null, error: { code: ACP_ERROR_CODES.PARSE_ERROR, message: 'Parse error' } });
      return;
    }
    if (isJsonRpcResponse(parsed)) {
      this.resolveClientRequest(parsed);
      return;
    }
    if (isJsonRpcRequest(parsed)) {
      await this.handleRequest(parsed);
      return;
    }
    if (isJsonRpcNotification(parsed)) {
      await this.handleNotification(parsed);
      return;
    }
    this.write({ jsonrpc: '2.0', id: null, error: { code: ACP_ERROR_CODES.INVALID_REQUEST, message: 'Invalid request' } });
  }

  private async handleNotification(notification: JsonRpcNotification): Promise<void> {
    if (notification.method === ACP_METHODS.CANCEL) {
      const params = notification.params as CancelNotification | undefined;
      const session = params && typeof params.sessionId === 'string' ? this.sessions.get(params.sessionId) : undefined;
      if (session) {
        session.cancelled = true;
        try {
          session.loop?.abort();
        } catch {
          // Cancellation is best effort.
        }
      }
    }
  }

  private async handleRequest(request: JsonRpcRequest): Promise<void> {
    try {
      switch (request.method) {
        case ACP_METHODS.INITIALIZE:
          this.writeResult(request.id, this.initialize(request.params as InitializeRequest | undefined));
          return;
        case ACP_METHODS.NEW_SESSION:
          this.writeResult(request.id, this.newSession(request.params as NewSessionRequest | undefined));
          return;
        case ACP_METHODS.PROMPT:
          this.writeResult(request.id, await this.prompt(request.params as PromptRequest | undefined));
          return;
        case ACP_METHODS.SET_MODE:
          this.writeResult(request.id, this.setMode(request.params as SetSessionModeRequest | undefined));
          return;
        case ACP_METHODS.LIST:
          this.writeResult(request.id, this.listSessions(request.params as ListSessionsRequest | undefined));
          return;
        case ACP_METHODS.CLOSE:
          this.writeResult(request.id, this.closeSession(request.params as CloseSessionRequest | undefined));
          return;
        case ACP_METHODS.LOAD:
          this.writeError(request.id, ACP_ERROR_CODES.METHOD_NOT_FOUND, 'session/load is not supported');
          return;
        default:
          this.writeError(request.id, ACP_ERROR_CODES.METHOD_NOT_FOUND, `Unknown method: ${request.method}`);
      }
    } catch (error) {
      const code = (error as { acpCode?: number }).acpCode ?? ACP_ERROR_CODES.INTERNAL_ERROR;
      this.writeError(request.id, code, error instanceof Error ? error.message : String(error));
    }
  }

  private initialize(params: InitializeRequest | undefined): InitializeResult {
    if (!params || typeof params.protocolVersion !== 'number') {
      throw this.paramsError('initialize requires protocolVersion');
    }
    const capabilities: AgentCapabilities = {
      loadSession: false,
      promptCapabilities: { image: false, audio: false, embeddedContext: false },
      mcpCapabilities: { http: false, sse: false },
      sessionCapabilities: { list: {}, close: {} }
    };
    return {
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentCapabilities: capabilities,
      agentInfo: { name: this.agentName, version: this.agentVersion }
    };
  }

  private paramsError(message: string): Error & { acpCode: number } {
    const error = new Error(message) as Error & { acpCode: number };
    error.acpCode = ACP_ERROR_CODES.INVALID_PARAMS;
    return error;
  }

  private newSession(params: NewSessionRequest | undefined): NewSessionResponse {
    if (!params || typeof params.cwd !== 'string' || !params.cwd.trim()) {
      throw this.paramsError('session/new requires cwd');
    }
    if (Array.isArray(params.mcpServers) && params.mcpServers.length > 0) {
      throw this.paramsError('MCP servers are not supported by this agent');
    }
    if (Array.isArray(params.additionalDirectories) && params.additionalDirectories.length > 0) {
      throw this.paramsError('additionalDirectories is not supported by this agent');
    }
    let cwd: string;
    try {
      cwd = fs.realpathSync(path.resolve(params.cwd));
      if (!fs.statSync(cwd).isDirectory()) throw new Error('not a directory');
    } catch {
      throw this.paramsError(`cwd is not an accessible directory: ${params.cwd}`);
    }
    if (this.workspaceRoot === null) {
      this.workspaceRoot = cwd;
      process.chdir(cwd);
    } else if (this.workspaceRoot !== cwd) {
      throw this.paramsError(`server is bound to ${this.workspaceRoot}; one workspace per server`);
    }
    const sessionId = crypto.randomUUID();
    this.sessions.set(sessionId, {
      id: sessionId,
      cwd,
      modeId: MODES.currentModeId,
      loop: null,
      busy: false,
      cancelled: false,
      updatedAt: Date.now(),
      queue: Promise.resolve()
    });
    return {
      sessionId,
      modes: {
        currentModeId: MODES.currentModeId,
        availableModes: MODES.availableModes.map((mode) => ({ ...mode }))
      }
    };
  }

  private requireSession(sessionId: unknown): AcpSession {
    if (typeof sessionId !== 'string' || !sessionId) throw this.paramsError('sessionId is required');
    const session = this.sessions.get(sessionId);
    if (!session) {
      const error = new Error(`Unknown session: ${sessionId}`) as Error & { acpCode: number };
      error.acpCode = ACP_ERROR_CODES.RESOURCE_NOT_FOUND;
      throw error;
    }
    return session;
  }

  private async prompt(params: PromptRequest | undefined): Promise<PromptResponse> {
    if (!params || !Array.isArray(params.prompt)) {
      throw this.paramsError('session/prompt requires a prompt array');
    }
    const session = this.requireSession(params.sessionId);
    const text = textFromPrompt(params.prompt);
    if (text === null || !text.trim()) {
      return { stopReason: 'refusal' };
    }
    session.queue = session.queue.then(
      () => this.runTurn(session, text),
      () => this.runTurn(session, text)
    );
    const stopReason = await session.queue as StopReason;
    return { stopReason };
  }

  private async runTurn(session: AcpSession, text: string): Promise<StopReason> {
    session.updatedAt = Date.now();
    session.cancelled = false;
    session.busy = true;
    const taskId = `acp-${crypto.randomUUID()}`;
    const sink = {
      readyState: 1,
      send: (payload: string) => this.onLoopPayload(session, payload)
    };
    const loop = this.loopFactory
      ? this.loopFactory({ sessionId: session.id, taskId, userPrompt: text, cwd: session.cwd, sink })
      : new AgentLoop(sink, taskId, text);
    const autonomy = MODE_TO_AUTONOMY[session.modeId];
    if (autonomy) {
      try {
        loop.setAutonomyMode(autonomy);
      } catch {
        // A loop without autonomy control simply keeps its configured mode.
      }
    }
    loop.waitForDecision = async (request: unknown) => this.requestDecision(session, loop, request);
    session.loop = loop;
    let stopReason: StopReason = 'end_turn';
    try {
      await loop.run();
    } catch {
      stopReason = 'refusal';
    } finally {
      session.loop = null;
      session.busy = false;
      if (session.cancelled) stopReason = 'cancelled';
    }
    return stopReason;
  }

  private requestDecision(session: AcpSession, loop: AgentLoop, request: unknown): Promise<{ optionId: string; label: string } | null> {
    if (request === null || typeof request !== 'object' || Array.isArray(request)) return Promise.resolve(null);
    const record = request as Record<string, unknown>;
    const options = Array.isArray(record.options) ? record.options : [];
    const permissionOptions: PermissionOption[] = [];
    const labels = new Map<string, string>();
    for (const option of options) {
      if (option === null || typeof option !== 'object' || Array.isArray(option)) continue;
      const item = option as Record<string, unknown>;
      const id = typeof item.id === 'string' ? item.id : '';
      const label = typeof item.label === 'string' ? item.label : id;
      if (!id) continue;
      labels.set(id, label);
      permissionOptions.push({ optionId: id, name: label, kind: 'allow_once' });
    }
    if (permissionOptions.length === 0) return Promise.resolve(null);
    const toolCall: ToolCall = {
      toolCallId: typeof record.id === 'string' ? record.id : crypto.randomUUID(),
      title: typeof record.question === 'string' ? record.question.slice(0, 300) : 'Decision required',
      kind: 'other',
      status: 'pending'
    };
    return this.sendClientRequest<RequestPermissionResponse>(session, ACP_METHODS.REQUEST_PERMISSION, {
      sessionId: session.id,
      toolCall,
      options: permissionOptions
    }).then((response) => {
      if (!response || response.outcome.outcome !== 'selected') return null;
      const optionId = response.outcome.optionId;
      const label = labels.get(optionId);
      if (!label) return null;
      return { optionId, label };
    }).catch(() => null);
  }

  private onLoopPayload(session: AcpSession, payload: string): void {
    let event: AgentLoopEvent;
    try {
      event = JSON.parse(payload) as AgentLoopEvent;
    } catch {
      return;
    }
    this.onLoopEvent(session, event);
  }

  private onLoopEvent(session: AcpSession, event: AgentLoopEvent): void {
    switch (event.type) {
      case 'agent_message': {
        this.notify(session.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: String(event.content ?? '') } });
        return;
      }
      case 'agent_reasoning': {
        const text = String(event.content ?? '');
        if (text) this.notify(session.id, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } });
        return;
      }
      case 'status':
      case 'notice': {
        const text = String(event.message ?? '');
        if (text) this.notify(session.id, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } });
        return;
      }
      case 'warning':
      case 'budget_warning':
      case 'error': {
        const text = String(event.message ?? 'Task error');
        this.notify(session.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
        return;
      }
      case 'step_start': {
        const tool = String(event.tool ?? 'tool');
        const args = event.args !== null && typeof event.args === 'object' && !Array.isArray(event.args)
          ? event.args as Record<string, unknown>
          : {};
        const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : crypto.randomUUID();
        this.notify(session.id, {
          sessionUpdate: 'tool_call',
          toolCallId,
          title: toolTitle(tool, args),
          kind: toolKind(tool),
          status: 'in_progress',
          rawInput: args
        });
        return;
      }
      case 'step_complete': {
        const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : null;
        if (!toolCallId) return;
        const result = event.result as { success?: boolean } | undefined;
        const status: ToolCallStatus = result && result.success === false ? 'failed' : 'completed';
        this.notify(session.id, {
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status,
          content: [{ type: 'content', content: { type: 'text', text: bounded(event.result) } }]
        });
        return;
      }
      case 'step_error': {
        const toolCallId = typeof event.toolCallId === 'string' ? event.toolCallId : null;
        if (!toolCallId) return;
        this.notify(session.id, {
          sessionUpdate: 'tool_call_update',
          toolCallId,
          status: 'failed',
          content: [{ type: 'content', content: { type: 'text', text: bounded(event.error ?? 'tool failed') } }]
        });
        return;
      }
      case 'agent_plan': {
        const plan = Array.isArray(event.plan) ? event.plan : [];
        this.notify(session.id, {
          sessionUpdate: 'plan',
          entries: plan.map((entry) => {
            const item = entry !== null && typeof entry === 'object' && !Array.isArray(entry)
              ? entry as Record<string, unknown>
              : {};
            const status = item.status === 'completed' || item.status === 'in_progress' ? item.status : 'pending';
            return {
              content: String(item.text ?? item.content ?? 'step'),
              priority: 'medium' as const,
              status
            };
          })
        });
        return;
      }
      case 'approval_request': {
        const toolCallId = String(event.toolCallId ?? '');
        if (!toolCallId) return;
        const args = event.args !== null && typeof event.args === 'object' && !Array.isArray(event.args)
          ? event.args as Record<string, unknown>
          : {};
        const tool = String(event.tool ?? 'tool');
        const toolCall: ToolCall = {
          toolCallId,
          title: toolTitle(tool, args),
          kind: toolKind(tool),
          status: 'pending',
          rawInput: args
        };
        const options: PermissionOption[] = [
          { optionId: 'allow_once', name: 'Allow this action', kind: 'allow_once' },
          { optionId: 'reject_once', name: 'Reject this action', kind: 'reject_once' }
        ];
        void this.sendClientRequest<RequestPermissionResponse>(session, ACP_METHODS.REQUEST_PERMISSION, {
          sessionId: session.id,
          toolCall,
          options
        }).then((response) => {
          const approved = response?.outcome.outcome === 'selected' && response.outcome.optionId === 'allow_once';
          session.loop?.handleApprovalResponse(toolCallId, approved);
        }).catch(() => {
          session.loop?.handleApprovalResponse(toolCallId, false);
        });
        return;
      }
      default:
        return;
    }
  }

  private notify(sessionId: string, update: SessionUpdate): void {
    const notification: JsonRpcNotification<SessionNotification> = {
      jsonrpc: '2.0',
      method: ACP_METHODS.UPDATE,
      params: { sessionId, update }
    };
    this.write(notification);
  }

  private setMode(params: SetSessionModeRequest | undefined): Record<string, never> {
    if (!params || typeof params.modeId !== 'string') throw this.paramsError('session/set_mode requires modeId');
    const session = this.requireSession(params.sessionId);
    if (!MODES.availableModes.some((mode) => mode.id === params.modeId)) {
      throw this.paramsError(`Unknown mode: ${params.modeId}`);
    }
    session.modeId = params.modeId;
    session.updatedAt = Date.now();
    const autonomy = MODE_TO_AUTONOMY[session.modeId];
    if (autonomy && session.loop) {
      try {
        session.loop.setAutonomyMode(autonomy);
      } catch {
        // The running loop keeps its mode; the next turn picks the new one.
      }
    }
    this.notify(session.id, { sessionUpdate: 'current_mode_update', currentModeId: session.modeId });
    return {};
  }

  private listSessions(params: ListSessionsRequest | undefined): ListSessionsResponse {
    const filter = params && typeof params.cwd === 'string' ? path.resolve(params.cwd) : null;
    const sessions: SessionInfo[] = [];
    for (const session of this.sessions.values()) {
      if (filter && session.cwd !== filter) continue;
      sessions.push({
        sessionId: session.id,
        cwd: session.cwd,
        updatedAt: new Date(session.updatedAt).toISOString()
      });
    }
    sessions.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
    return { sessions };
  }

  private closeSession(params: CloseSessionRequest | undefined): Record<string, never> {
    const session = this.requireSession(params?.sessionId);
    session.cancelled = true;
    try {
      session.loop?.abort();
    } catch {
      // Closing never blocks on cancellation.
    }
    this.sessions.delete(session.id);
    return {};
  }

  private sendClientRequest<T>(session: AcpSession, method: string, params: Record<string, unknown>): Promise<T> {
    const id = `server-${this.nextClientRequestId++}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, this.permissionTimeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer
      });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  private resolveClientRequest(response: JsonRpcResponse): void {
    if (response.id === null || response.id === undefined) return;
    const pending = this.pending.get(response.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(response.id);
    if (response.error) {
      pending.reject(new Error(response.error.message));
      return;
    }
    pending.resolve(response.result);
  }

  private writeResult(id: string | number, result: unknown): void {
    this.write({ jsonrpc: '2.0', id, result });
  }

  private writeError(id: string | number, code: number, message: string): void {
    const error: JsonRpcError = { code, message };
    this.write({ jsonrpc: '2.0', id, error });
  }

  private write(message: JsonRpcResponse | JsonRpcNotification<unknown> | JsonRpcRequest<unknown>): void {
    if (!this.output || this.closed) return;
    try {
      this.output.write(`${JSON.stringify(message)}\n`);
    } catch {
      // A closed pipe must not crash the agent process.
    }
  }
}

export { MODES as ACP_SESSION_MODES };
