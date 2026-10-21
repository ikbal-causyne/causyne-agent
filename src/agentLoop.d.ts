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

export class AgentLoop {
  constructor(eventSink: AgentLoopEventSink | null, taskId: string, userPrompt: string | null);

  eventSink: AgentLoopEventSink | null;
  taskId: string;
  userPrompt: string | null;
  workspaceRoot: string;
  autonomyOverride: string | null;
  config: AgentLoopConfig;
  stepsCompleted: number;

  run(): Promise<void>;
  abort(): void;
  rearmAbortController(): void;
  setAutonomyMode(mode: 'A' | 'B' | 'C' | string): void;
  emitEvent(event: AgentLoopEvent): void;
  waitForApproval(toolCallId: string): Promise<boolean>;
  handleApprovalResponse(toolCallId: string, decision: ApprovalDecision | boolean): void;
  waitForDecision(request: Record<string, unknown>): Promise<unknown>;
  updateTierLimits(): void;
}
