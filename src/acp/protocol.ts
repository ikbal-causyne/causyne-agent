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

export interface McpServer {
  name: string;
  command?: string;
  args?: string[];
  env?: Array<{ name: string; value: string }> | Record<string, string>;
  url?: string;
  type?: string;
}

export interface NewSessionRequest {
  cwd: string;
  mcpServers: McpServer[];
  additionalDirectories?: string[];
}

export interface NewSessionResponse {
  sessionId: string;
  modes?: SessionModeState;
}

export interface PromptRequest {
  sessionId: string;
  prompt: ContentBlock[];
  messageId?: string;
}

export type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';

export interface PromptResponse {
  stopReason: StopReason;
}

export interface SetSessionModeRequest {
  sessionId: string;
  modeId: string;
}

export type SetSessionModeResponse = Record<string, never>;

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
  return record.jsonrpc === '2.0'
    && (typeof record.id === 'string' || typeof record.id === 'number')
    && typeof record.method === 'string';
}

export function isJsonRpcResponse(value: unknown): value is JsonRpcResponse {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.jsonrpc === '2.0'
    && (typeof record.id === 'string' || typeof record.id === 'number' || record.id === null)
    && ('result' in record || 'error' in record);
}

export function isJsonRpcNotification(value: unknown): value is JsonRpcNotification {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record.jsonrpc === '2.0' && typeof record.method === 'string' && !('id' in record);
}
