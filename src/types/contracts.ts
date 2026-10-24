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

export type HookEvent = 'PreToolUse' | 'PostToolUse';

export interface HookRule {
  event: HookEvent;
  command: string[];
  name?: string;
  tool?: string;
  tools?: string[];
  timeoutMs?: number;
  enabled?: boolean;
}

export interface HookDecision {
  denied: boolean;
  messages: string[];
  reason?: string;
}

export type PlanFailureClass =
  | 'not_found'
  | 'permission'
  | 'timeout'
  | 'network'
  | 'rate_limited'
  | 'invalid_args'
  | 'syntax'
  | 'exit_nonzero'
  | 'failed';

export interface PlanStep {
  tool: string;
  note: string;
  ok: boolean;
  why?: PlanFailureClass;
}

export interface PlanTemplate {
  id: string;
  archetype: string;
  keywords: string[];
  steps: PlanStep[];
  uses: number;
  wins: number;
  createdAt: number;
  updatedAt: number;
}

export interface PlanMatch {
  template: PlanTemplate;
  similarity: number;
  matchType: 'exact' | 'fuzzy';
  telemetry: {
    keywordCount: number;
    lookupMs: number;
  };
}

/** APC pipeline wall-clock latency breakdown matching Table 3 (Page 9) */
export interface APCPipelineLatency {
  planMs: number;
  actMs: number;
  keywordExtractionMs: number;
  cacheLookupMs: number;
  cacheGenerationMs: number;
  totalMs: number;
}

/** APC model and cache overhead cost breakdown matching Table 2 (Page 9) */
export interface APCCostBreakdown {
  largePlannerCost: number;
  smallPlannerCost: number;
  actorCost: number;
  cacheOverhead: {
    keywordExtractionCost: number;
    cacheGenerationCost: number;
    totalOverheadCost: number;
    overheadPercentage: number;
  };
  totalCost: number;
}

/** APC cache lookup scalability benchmark entry matching Table 5 (Page 10) */
export interface APCLookupScalabilityPoint {
  cacheSize: number;
  exactHitLatencyUs: number;
  exactMissLatencyUs: number;
  fuzzyHitLatencyUs: number;
  fuzzyMissLatencyUs: number;
}

/** APC fuzzy keyword matching similarity threshold profile matching Table 6 (Page 10) */
export interface APCFuzzyThresholdProfile {
  threshold: number;
  hitRate: number;
  cost: number;
  accuracy: number;
  planningLatencySec: number;
  totalLatencySec: number;
}

/** APC cold-start progression entry matching Table 7 (Page 10) */
export interface APCColdStartPoint {
  queryPercentile: number;
  cacheEntries: number;
  hitRate: number;
  cost: number;
  planningLatencySec: number;
  cacheGenLatencySec: number;
  totalLatencySec: number;
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
