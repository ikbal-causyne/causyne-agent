export interface AgentLoopEvent {
  type: string;
  [key: string]: unknown;
}

export interface AgentLoopEventSink {
  readyState?: number;
  send(payload: string): void;
}

export interface AgentLoopConfig {
  autonomyMode?: 'A' | 'B' | 'C' | string;
  maxStepsPerTask?: number;
  tokenBudget?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ApprovalDecision {
  approved: boolean;
  [key: string]: unknown;
}

export interface AgentLoopApprovalScope {
  grantAlways(toolName: unknown): void;
  isAlwaysAllowed(toolName: unknown): boolean;
  listAlwaysAllowed(): string[];
  revokeAllAlways(): number;
  revokeAlways(toolName: unknown): boolean;
}

export interface AgentLoopOptions {
  workspaceRoot?: string;
  memorySessionId?: string | null;
  approvalScope?: AgentLoopApprovalScope;
}

export class AgentLoop {
  constructor(
    eventSink: AgentLoopEventSink | null,
    taskId: string,
    userPrompt: string | null,
    options?: AgentLoopOptions
  );

  eventSink: AgentLoopEventSink | null;
  taskId: string;
  userPrompt: string | null;
  workspaceRoot: string;
  approvalScope: AgentLoopApprovalScope;
  autonomyOverride: string | null;
  config: AgentLoopConfig;
  stepsCompleted: number;

  run(): Promise<void>;
  abort(): void;
  rearmAbortController(): void;
  setAutonomyMode(mode: 'A' | 'B' | 'C' | string): void;
  isAlwaysAllowed(toolName: unknown): boolean;
  emitEvent(event: AgentLoopEvent): void;
  waitForApproval(toolCallId: string): Promise<boolean>;
  handleApprovalResponse(toolCallId: string, decision: ApprovalDecision | boolean): void;
  waitForDecision(request: Record<string, unknown>): Promise<unknown>;
  updateTierLimits(): void;
}
