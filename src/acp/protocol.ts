/**
 * Agent Client Protocol (ACP) types for Causyne Agent.
 *
 * JSON-RPC 2.0 over stdio with newline-delimited framing. The shapes here
 * follow the published ACP schema; the agent advertises only the capabilities
 * it actually implements.
 */

export const ACP_PROTOCOL_VERSION = 1;

export const ACP_METHODS = {
  INITIALIZE: 'initialize',
  NEW_SESSION: 'session/new',
  PROMPT: 'session/prompt',
  CANCEL: 'session/cancel',
  UPDATE: 'session/update',
  LOAD: 'session/load',
  FORK: 'session/fork',
  LIST: 'session/list',
  CLOSE: 'session/close',
  SET_MODE: 'session/set_mode',
  SET_MODEL: 'session/set_model',
  SET_CONFIG_OPTION: 'session/set_config_option',
  AUTHENTICATE: 'authenticate',
  REQUEST_PERMISSION: 'session/request_permission',
  READ_TEXT_FILE: 'fs/read_text_file',
  WRITE_TEXT_FILE: 'fs/write_text_file'
} as const;

export const ACP_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  AUTH_REQUIRED: -32000,
  RESOURCE_NOT_FOUND: -32002,
  REQUEST_CANCELLED: -32800
} as const;

export interface JsonRpcRequest<T = Record<string, unknown>> {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: T;
}

export interface JsonRpcResponse<T = unknown> {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: T;
  error?: JsonRpcError;
}

export interface JsonRpcNotification<T = Record<string, unknown>> {
  jsonrpc: '2.0';
  method: string;
  params?: T;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface ContentBlockText {
  type: 'text';
  text: string;
  annotations?: unknown;
}

export interface ContentBlockImage {
  type: 'image';
  mimeType: string;
  data: string;
}

export interface ContentBlockAudio {
  type: 'audio';
  mimeType: string;
  data: string;
}

export interface ContentBlockResourceLink {
  type: 'resource_link';
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  size?: number;
  title?: string;
}

export interface EmbeddedResource {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

export interface ContentBlockResource {
  type: 'resource';
  resource: EmbeddedResource;
}

export type ContentBlock =
  | ContentBlockText
  | ContentBlockImage
  | ContentBlockAudio
  | ContentBlockResourceLink
  | ContentBlockResource;

export interface ClientInfo {
  name: string;
  title?: string;
  version?: string;
}

export interface FileSystemCapabilities {
  readTextFile?: boolean;
  writeTextFile?: boolean;
}

export interface SessionClientCapabilities {
  notices?: boolean;
}

export interface ClientCapabilities {
  fs?: FileSystemCapabilities;
  terminal?: boolean;
  session?: SessionClientCapabilities;
  _meta?: Record<string, unknown>;
}

export interface InitializeRequest {
  protocolVersion: number;
  clientCapabilities?: ClientCapabilities;
  clientInfo?: ClientInfo;
}

export interface PromptCapabilities {
  image?: boolean;
  audio?: boolean;
  embeddedContext?: boolean;
}

export interface McpCapabilities {
  http?: boolean;
  sse?: boolean;
}

export interface SessionCapabilities {
  list?: Record<string, never>;
  delete?: Record<string, never>;
  additionalDirectories?: Record<string, never>;
  close?: Record<string, never>;
  fork?: Record<string, never>;
}

export interface AgentCapabilities {
  loadSession?: boolean;
  promptCapabilities?: PromptCapabilities;
  mcpCapabilities?: McpCapabilities;
  sessionCapabilities?: SessionCapabilities;
}

export interface AgentInfo {
  name: string;
  title?: string;
  version: string;
}

export interface InitializeResult {
  protocolVersion: number;
  agentCapabilities: AgentCapabilities;
  agentInfo?: AgentInfo;
  authMethods?: unknown[];
}

export interface SessionMode {
  id: string;
  name: string;
  description?: string;
}

export interface SessionModeState {
  currentModeId: string;
  availableModes: SessionMode[];
}

export interface AcpModelInfo {
  modelId?: string;
  id?: string;
  value?: string;
  name?: string;
  label?: string;
  description?: string;
}

export interface SessionModelState {
  currentModelId?: string;
  availableModels?: Array<AcpModelInfo | string>;
}

export interface SessionConfigSelectOption {
  value: string;
  name?: string;
  description?: string;
}

export interface SessionConfigSelectGroup {
  group: string;
  name?: string;
  options: SessionConfigSelectOption[];
}

export interface SessionConfigOption {
  id: string;
  name?: string;
  description?: string;
  category?: string;
  type?: string;
  currentValue?: string;
  options?: Array<SessionConfigSelectOption | SessionConfigSelectGroup>;
}

export interface AcpDiscoveredSessionModels {
  currentModelId?: string | undefined;
  availableModels: string[];
  modelLabels: Record<string, string>;
  usesConfigOption: boolean;
  configOptionId?: string | undefined;
}

export interface AcpDiscoveredVariantChoice {
  value: string;
  name?: string | undefined;
  description?: string | undefined;
}

export interface AcpDiscoveredVariantOption {
  configOptionId: string;
  currentValue?: string | undefined;
  options: AcpDiscoveredVariantChoice[];
}

export interface McpServerHeader {
  name: string;
  value: string;
}

export interface McpServer {
  name: string;
  command?: string;
  args?: string[];
  env?: Array<{ name: string; value: string }> | Record<string, string>;
  url?: string;
  type?: string;
  headers?: McpServerHeader[];
}

function normalizeAcpKvPairs(raw: unknown): Array<{ name: string; value: string }> {
  if (Array.isArray(raw)) {
    const pairs: Array<{ name: string; value: string }> = [];
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const obj = item as Record<string, unknown>;
      if (typeof obj.name === 'string' && obj.name.length > 0 && typeof obj.value === 'string') {
        pairs.push({ name: obj.name, value: obj.value });
      }
    }
    return pairs;
  }
  if (raw && typeof raw === 'object') {
    const pairs: Array<{ name: string; value: string }> = [];
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (k.length > 0 && typeof v === 'string') {
        pairs.push({ name: k, value: v });
      }
    }
    return pairs;
  }
  return [];
}

/**
 * Normalize MCP server descriptors to strictly match the published ACP JSON-RPC schema
 * (`McpServerHttp | McpServerSse | McpServerStdio`).
 *
 * ACP peers using Zod validation (such as OpenCode) reject stdio MCP servers when
 * `env` or `args` is omitted/undefined, and reject http/sse entries when `headers`
 * is omitted. Preserves all server entries and credentials without degrading capabilities.
 */
export function normalizeAcpMcpServers(rawServers: readonly unknown[] | undefined): McpServer[] {
  if (!Array.isArray(rawServers) || rawServers.length === 0) return [];
  const normalized: McpServer[] = [];
  for (const entry of rawServers) {
    if (!entry || typeof entry !== 'object') continue;
    const raw = entry as Record<string, unknown>;
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name) continue;

    const rawType = typeof raw.type === 'string' ? raw.type.trim().toLowerCase() : '';
    if ((rawType === 'http' || rawType === 'sse') && typeof raw.url === 'string' && raw.url.trim()) {
      normalized.push({
        type: rawType,
        name,
        url: raw.url.trim(),
        headers: normalizeAcpKvPairs(raw.headers)
      });
      continue;
    }

    if (typeof raw.command === 'string' && raw.command.trim()) {
      const args = Array.isArray(raw.args)
        ? raw.args.filter((a): a is string => typeof a === 'string')
        : [];
      normalized.push({
        name,
        command: raw.command.trim(),
        args,
        env: normalizeAcpKvPairs(raw.env)
      });
    }
  }
  return normalized;
}

export interface NewSessionRequest {
  cwd: string;
  mcpServers: McpServer[];
  additionalDirectories?: string[];
}

export interface NewSessionResponse {
  sessionId: string;
  modes?: SessionModeState;
  models?: SessionModelState;
  configOptions?: SessionConfigOption[];
}

export interface PromptRequest {
  sessionId: string;
  prompt: ContentBlock[];
  messageId?: string;
}

export type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';

export interface PromptResponse {
  stopReason: StopReason;
  usage?: AcpUsage;
}

export interface AcpUsage {
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens?: number;
  cachedWriteTokens?: number;
  thoughtTokens?: number;
}

export interface SetSessionModeRequest {
  sessionId: string;
  modeId: string;
}

export type SetSessionModeResponse = Record<string, never>;

export interface SetSessionModelRequest {
  sessionId: string;
  modelId: string;
}

export type SetSessionModelResponse = Record<string, never>;

export interface AuthenticateRequest {
  methodId: string;
  params?: Record<string, unknown>;
}

export interface AuthenticateResponse {
  authenticated: boolean;
  message?: string;
}

export interface CancelNotification {
  sessionId: string;
}

export interface ListSessionsRequest {
  cwd?: string;
  cursor?: string;
}

export interface SessionInfo {
  sessionId: string;
  cwd: string;
  title?: string;
  updatedAt?: string;
}

export interface ListSessionsResponse {
  sessions: SessionInfo[];
  nextCursor?: string;
}

export interface CloseSessionRequest {
  sessionId: string;
}

export type CloseSessionResponse = Record<string, never>;

export interface LoadSessionRequest {
  sessionId: string;
  cwd?: string;
  mcpServers?: McpServer[];
}

export interface LoadSessionResponse {
  modes?: SessionModeState;
}

export interface ForkSessionRequest {
  sessionId: string;
  cwd?: string;
}

export interface ForkSessionResponse {
  sessionId: string;
  modes?: SessionModeState;
}

export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export type ToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other';

export interface ToolCallContentBlock {
  type: 'content';
  content: ContentBlock;
}

export interface ToolCallContentDiff {
  type: 'diff';
  path: string;
  oldText?: string | null;
  newText: string;
}

export interface ToolCallContentTerminal {
  type: 'terminal';
  terminalId: string;
}

export type ToolCallContent = ToolCallContentBlock | ToolCallContentDiff | ToolCallContentTerminal;

export interface ToolCallLocation {
  path: string;
  line?: number;
}

export interface ToolCall {
  toolCallId: string;
  title: string;
  kind?: ToolKind;
  status?: ToolCallStatus;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
  rawInput?: unknown;
  rawOutput?: unknown;
}

export interface AgentMessageChunkUpdate {
  sessionUpdate: 'agent_message_chunk';
  content: ContentBlock;
}

export interface AgentThoughtChunkUpdate {
  sessionUpdate: 'agent_thought_chunk';
  content: ContentBlock;
}

export interface UserMessageChunkUpdate {
  sessionUpdate: 'user_message_chunk';
  content: ContentBlock;
}

export interface ToolCallUpdateNotification {
  sessionUpdate: 'tool_call';
  toolCallId: string;
  title: string;
  kind?: ToolKind;
  status?: ToolCallStatus;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
  rawInput?: unknown;
  rawOutput?: unknown;
}

export interface ToolCallStatusUpdateNotification {
  sessionUpdate: 'tool_call_update';
  toolCallId: string;
  title?: string;
  kind?: ToolKind;
  status?: ToolCallStatus;
  content?: ToolCallContent[];
  rawOutput?: unknown;
}

export interface PlanEntryUpdate {
  content: string;
  priority: 'high' | 'medium' | 'low';
  status: 'pending' | 'in_progress' | 'completed';
}

export interface PlanUpdateNotification {
  sessionUpdate: 'plan';
  entries: PlanEntryUpdate[];
}

export interface CurrentModeUpdateNotification {
  sessionUpdate: 'current_mode_update';
  currentModeId: string;
}

export type SessionUpdate =
  | AgentMessageChunkUpdate
  | AgentThoughtChunkUpdate
  | UserMessageChunkUpdate
  | ToolCallUpdateNotification
  | ToolCallStatusUpdateNotification
  | PlanUpdateNotification
  | CurrentModeUpdateNotification;

export interface SessionNotification {
  sessionId: string;
  update: SessionUpdate;
}

export type PermissionOptionKind = 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always';

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: PermissionOptionKind;
}

export interface RequestPermissionRequest {
  sessionId: string;
  toolCall: ToolCall;
  options: PermissionOption[];
}

export interface PermissionSelectedOutcome {
  outcome: 'selected';
  optionId: string;
}

export interface PermissionCancelledOutcome {
  outcome: 'cancelled';
}

export type RequestPermissionResponse = {
  outcome: PermissionSelectedOutcome | PermissionCancelledOutcome;
};

export interface ReadTextFileRequest {
  sessionId: string;
  path: string;
  line?: number;
  limit?: number;
}

export interface ReadTextFileResponse {
  content: string;
}

export interface WriteTextFileRequest {
  sessionId: string;
  path: string;
  content: string;
}

export type WriteTextFileResponse = Record<string, never>;

export function isJsonRpcRequest(value: unknown): value is JsonRpcRequest {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const validId = typeof record.id === 'string'
    || (typeof record.id === 'number' && Number.isFinite(record.id));
  return record.jsonrpc === '2.0'
    && validId
    && !('result' in record) && !('error' in record)
    && typeof record.method === 'string'
    && record.method.trim().length > 0;
}

export function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.jsonrpc !== '2.0' || 'method' in record) return false;
  const validId = typeof record.id === 'string'
    || (typeof record.id === 'number' && Number.isFinite(record.id))
    || record.id === null;
  if (!validId) return false;
  const hasResult = 'result' in record;
  const hasError = 'error' in record;
  if (hasResult === hasError) return false;
  if (hasError) {
    const err = record.error;
    if (err === null || typeof err !== 'object' || Array.isArray(err)) return false;
    const errObj = err as Record<string, unknown>;
    if (typeof errObj.code !== 'number' || !Number.isInteger(errObj.code)) return false;
    if (typeof errObj.message !== 'string') return false;
  }
  return true;
}

export function isJsonRpcNotification(value: unknown): value is JsonRpcNotification {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.jsonrpc === '2.0'
    && typeof record.method === 'string'
    && record.method.trim().length > 0
    && !('id' in record) && !('result' in record) && !('error' in record);
}

/**
 * Extract live available models and active model ID from any ACP session/new,
 * session/load, session/set_config_option, or session/update payload.
 */
export function extractAcpSessionModels(payload: unknown): AcpDiscoveredSessionModels {
  const availableModels: string[] = [];
  const modelLabels: Record<string, string> = {};
  let currentModelId: string | undefined;
  let usesConfigOption = false;
  let configOptionId: string | undefined;

  if (!payload || typeof payload !== 'object') {
    return { availableModels, modelLabels, usesConfigOption };
  }

  const record = payload as Record<string, unknown>;

  const MAX_DISCOVERED_MODELS = 500;
  const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
  const registerModel = (rawId: unknown, rawLabel?: unknown): void => {
    if (typeof rawId !== 'string') return;
    const id = rawId.trim();
    if (!id || id.length > 200 || FORBIDDEN_KEYS.has(id)) return;
    if (!availableModels.includes(id)) {
      if (availableModels.length >= MAX_DISCOVERED_MODELS) return;
      availableModels.push(id);
    }
    if (typeof rawLabel === 'string' && rawLabel.trim()) {
      modelLabels[id] = rawLabel.trim().slice(0, 200);
    }
  };

  // 1. Inspect ACP v1 configOptions (e.g. OpenCode, Claude Agent ACP, Codex ACP, Gemini ACP)
  const configOptions = Array.isArray(record.configOptions) ? record.configOptions : [];
  for (const rawOpt of configOptions) {
    if (!rawOpt || typeof rawOpt !== 'object') continue;
    const opt = rawOpt as Record<string, unknown>;
    const optId = typeof opt.id === 'string' ? opt.id.trim().toLowerCase() : '';
    const optCategory = typeof opt.category === 'string' ? opt.category.trim().toLowerCase() : '';
    if (optCategory !== 'model' && optId !== 'model' && optId !== 'models') continue;

    usesConfigOption = true;
    configOptionId = typeof opt.id === 'string' && opt.id.trim() ? opt.id.trim() : 'model';
    if (typeof opt.currentValue === 'string' && opt.currentValue.trim()) {
      currentModelId = opt.currentValue.trim();
    }

    const options = Array.isArray(opt.options) ? opt.options : [];
    for (const entry of options) {
      if (!entry || typeof entry !== 'object') continue;
      const entryObj = entry as Record<string, unknown>;
      if (Array.isArray(entryObj.options)) {
        for (const sub of entryObj.options) {
          if (sub && typeof sub === 'object') {
            const subObj = sub as Record<string, unknown>;
            registerModel(subObj.value ?? subObj.modelId ?? subObj.id, subObj.name ?? subObj.label);
          }
        }
      } else {
        registerModel(entryObj.value ?? entryObj.modelId ?? entryObj.id, entryObj.name ?? entryObj.label);
      }
    }
  }

  // 2. Inspect ACP models state ({ currentModelId, availableModels })
  const modelsField = record.models;
  if (modelsField && typeof modelsField === 'object' && !Array.isArray(modelsField)) {
    const modelsObj = modelsField as Record<string, unknown>;
    if (!currentModelId && typeof modelsObj.currentModelId === 'string' && modelsObj.currentModelId.trim()) {
      currentModelId = modelsObj.currentModelId.trim();
    }
    const list = Array.isArray(modelsObj.availableModels) ? modelsObj.availableModels : [];
    for (const item of list) {
      if (typeof item === 'string') {
        registerModel(item);
      } else if (item && typeof item === 'object') {
        const itemObj = item as Record<string, unknown>;
        registerModel(itemObj.modelId ?? itemObj.id ?? itemObj.value, itemObj.name ?? itemObj.label);
      }
    }
  } else if (Array.isArray(modelsField)) {
    for (const item of modelsField) {
      if (typeof item === 'string') {
        registerModel(item);
      } else if (item && typeof item === 'object') {
        const itemObj = item as Record<string, unknown>;
        registerModel(itemObj.modelId ?? itemObj.id ?? itemObj.value, itemObj.name ?? itemObj.label);
      }
    }
  }

  // 3. Inspect top-level availableModels / currentModelId if present
  if (!currentModelId && typeof record.currentModelId === 'string' && record.currentModelId.trim()) {
    currentModelId = record.currentModelId.trim();
  }
  if (Array.isArray(record.availableModels)) {
    for (const item of record.availableModels) {
      if (typeof item === 'string') {
        registerModel(item);
      } else if (item && typeof item === 'object') {
        const itemObj = item as Record<string, unknown>;
        registerModel(itemObj.modelId ?? itemObj.id ?? itemObj.value, itemObj.name ?? itemObj.label);
      }
    }
  }

  if (currentModelId && (currentModelId.length > 200 || FORBIDDEN_KEYS.has(currentModelId))) {
    currentModelId = undefined;
  }
  if (currentModelId && !availableModels.includes(currentModelId)) {
    availableModels.unshift(currentModelId);
    if (availableModels.length > MAX_DISCOVERED_MODELS) {
      const removed = availableModels.pop();
      if (removed !== undefined) delete modelLabels[removed];
    }
  }

  return {
    currentModelId,
    availableModels,
    modelLabels,
    usesConfigOption,
    configOptionId
  };
}

/**
 * Extract live reasoning / thinking / effort configOption advertised by an ACP peer
 * in session/new, session/load, session/set_config_option, or session/update.
 */
export function extractAcpSessionVariants(payload: unknown): AcpDiscoveredVariantOption | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const configOptions = Array.isArray(record.configOptions) ? record.configOptions : [];
  const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
  const VARIANT_ID_RE = /^(?:thought[_-]?level|reasoning[_-]?effort|reasoning|effort|thinking[_-]?level|thinking[_-]?effort|thinking|variant)$/;

  for (const rawOpt of configOptions) {
    if (!rawOpt || typeof rawOpt !== 'object') continue;
    const opt = rawOpt as Record<string, unknown>;
    const rawId = typeof opt.id === 'string' ? opt.id.trim() : '';
    const optIdLower = rawId.toLowerCase();
    const optCategory = typeof opt.category === 'string' ? opt.category.trim().toLowerCase() : '';
    if (!rawId || rawId.length > 100 || FORBIDDEN_KEYS.has(rawId)) continue;
    const matchesCategory = optCategory === 'thought_level' || optCategory === 'reasoning' || optCategory === 'reasoning_effort';
    if (!matchesCategory && !VARIANT_ID_RE.test(optIdLower)) continue;

    const choices: AcpDiscoveredVariantChoice[] = [];
    const seen = new Set<string>();
    const pushChoice = (val: unknown, name?: unknown, desc?: unknown): void => {
      if (typeof val !== 'string') return;
      const clean = val.trim();
      if (!clean || clean.length > 80 || FORBIDDEN_KEYS.has(clean) || seen.has(clean)) return;
      seen.add(clean);
      choices.push({
        value: clean,
        ...(typeof name === 'string' && name.trim() ? { name: name.trim().slice(0, 120) } : {}),
        ...(typeof desc === 'string' && desc.trim() ? { description: desc.trim().slice(0, 200) } : {})
      });
    };

    const rawEntries = Array.isArray(opt.options) ? opt.options : [];
    for (const entry of rawEntries) {
      if (!entry || typeof entry !== 'object') continue;
      const entryObj = entry as Record<string, unknown>;
      if (Array.isArray(entryObj.options)) {
        for (const sub of entryObj.options) {
          if (sub && typeof sub === 'object') {
            const subObj = sub as Record<string, unknown>;
            pushChoice(subObj.value ?? subObj.id, subObj.name ?? subObj.label, subObj.description);
          }
        }
      } else {
        pushChoice(entryObj.value ?? entryObj.id, entryObj.name ?? entryObj.label, entryObj.description);
      }
    }

    const currentValue = typeof opt.currentValue === 'string' && opt.currentValue.trim() && opt.currentValue.length <= 80
      ? opt.currentValue.trim()
      : undefined;
    if (choices.length > 0 || currentValue) {
      return {
        configOptionId: rawId,
        ...(currentValue ? { currentValue } : {}),
        options: choices
      };
    }
  }
  return null;
}
