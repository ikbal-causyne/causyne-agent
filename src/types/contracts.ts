/**
 * Shared compile-time contracts for the incremental TypeScript migration.
 *
 * This module deliberately exports types only. Runtime data entering from a
 * model, MCP server, plugin, config file, subprocess, or filesystem still has
 * to be validated before it is treated as one of these shapes.
 */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface TextContentBlock {
  type: 'text';
  text: string;
}

export interface ImageContentBlock {
  type: 'image_url';
  image_url: {
    url: string;
    detail?: 'auto' | 'low' | 'high';
  };
}

export interface AudioContentBlock {
  type: 'input_audio';
  input_audio: {
    data: string;
    format: string;
  };
}

export type MessageContent = string | Array<TextContentBlock | ImageContentBlock | AudioContentBlock | JsonObject>;

export interface AgentMessage {
  role: MessageRole;
  content: MessageContent;
  name?: string;
  tool_call_id?: string;
  cacheAnchor?: string;
  spillPath?: string;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens?: number;
}

export interface ProviderResponse {
  content: string;
  usage: TokenUsage;
  reasoning?: string;
  toolCalls?: ToolCall[];
}

export interface ProviderChatOptions {
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  tools?: ToolSchema[];
  signal?: AbortSignal;
}

export interface JsonSchema {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: JsonPrimitive[];
  additionalProperties?: boolean | JsonSchema;
}

export interface ToolSchema {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface ToolCall {
  id?: string;
  name: string;
  arguments: JsonObject;
}

export interface ToolExecutionContext {
  workspace: string;
  signal?: AbortSignal;
  taskId?: string;
  sessionId?: string;
}

export interface ToolSuccess<T extends JsonValue = JsonValue> {
  success: true;
  result: T;
  metadata?: JsonObject;
}

export interface ToolFailure {
  success: false;
  error: string;
  code?: string;
  metadata?: JsonObject;
}

export type ToolResult<T extends JsonValue = JsonValue> = ToolSuccess<T> | ToolFailure;

export interface ToolModule<TArguments extends JsonObject = JsonObject, TResult extends JsonValue = JsonValue> {
  schema: ToolSchema;
  execute(arguments_: TArguments, context?: ToolExecutionContext): Promise<ToolResult<TResult>> | ToolResult<TResult>;
}

export type RiskLevel = 'safe' | 'moderate' | 'dangerous' | 'extreme' | 'forbidden';

export interface SandboxDecision {
  allowed: boolean;
  risk: RiskLevel;
  reason?: string;
}

export type ApprovalChoice = 'deny' | 'allow_once' | 'allow_always';

export interface ApprovalDecision {
  choice: ApprovalChoice;
  toolName: string;
  reason?: string;
}

export type PluginCapability = 'workspace:read' | 'workspace:write' | 'network' | 'subprocess';

export interface PluginToolManifest {
  name: string;
  description: string;
  parameters: JsonSchema;
  entry: string;
  export?: string;
  capabilities?: PluginCapability[];
  timeoutMs?: number;
}

export interface PluginSkillManifest {
  id: string;
  name?: string;
  description: string;
  file: string;
}

export interface PluginManifest {
  schemaVersion: 1;
  name: string;
  version: string;
  description: string;
  capabilities?: PluginCapability[];
  tools?: PluginToolManifest[];
  skills?: PluginSkillManifest[];
}

export interface AgentProfileManifest {
  schemaVersion: 1;
  name: string;
  description: string;
  instructions: string;
  toolScope: string[];
  maxSteps?: number;
  maxTokens?: number;
}

export interface TaskPhase {
  name: string;
  tools: string[];
  note: string;
}

export interface TaskPackScore {
  name: string;
  score: number;
}

export type TaskConfidence = 'low' | 'medium' | 'high';

export interface WorkspaceContext {
  framework?: string;
  projectType?: string;
  designSystem?: string;
  keyFiles?: string[];
}

export interface TaskShape {
  archetype: string;
  archetypeLabel: string;
  packs: TaskPackScore[];
  phases: TaskPhase[];
  confidence: TaskConfidence;
}

export type AgentEvent =
  | { type: 'model.started'; provider: string; model: string }
  | { type: 'model.delta'; text: string }
  | { type: 'tool.requested'; call: ToolCall }
  | { type: 'tool.completed'; callId?: string; result: ToolResult }
  | { type: 'approval.required'; toolName: string; risk: RiskLevel; reason?: string }
  | { type: 'session.notice'; message: string };
