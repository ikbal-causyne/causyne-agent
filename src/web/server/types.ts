import type http from 'node:http';
import type { createApprovalScope } from '../../approvalGrants.js';

export interface SkybridgeDecisionAnswer {
  optionId?: string | null | undefined;
  label: string;
  custom?: boolean | undefined;
}

export interface SkybridgeLoopLike {
  run(): Promise<void>;
  abort?(): void;
  resolveApproval?(toolCallId: string, approved: boolean): void;
  resolveDecision?(requestId: string, answer: SkybridgeDecisionAnswer | null): void;
  grantAlways?(toolName: string): void;
}

export type SkybridgeLoopFactory = (
  sink: { readyState: number; send(raw: string): void },
  taskId: string,
  prompt: string,
  options: {
    workspaceRoot: string;
    mode: string;
    permissionPreset?: string | undefined;
    sessionId?: string | undefined;
    provider?: string | undefined;
    model?: string | undefined;
  }
) => SkybridgeLoopLike;

export interface SkybridgeEntitlementClientLike {
  status(): Promise<any>;
  checkout(plan: string): Promise<any>;
  recover(recoveryCode: string): Promise<any>;
  portal(): Promise<any>;
}

export interface StartSkybridgeOptions {
  workspaceRoot?: string | undefined;
  port?: number | undefined;
  token?: string | undefined;
  allowedOrigins?: readonly string[] | undefined;
  loopFactory?: SkybridgeLoopFactory | undefined;
  entitlementClient?: SkybridgeEntitlementClientLike | undefined;
}

export interface SkybridgeHandle {
  url: string;
  origin: string;
  port: number;
  token: string;
  workspaceRoot: string;
  close(): Promise<void>;
}

export interface SessionFileEvidence {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  bytesWritten?: number | undefined;
  additions: number;
  deletions: number;
  hunks: Array<{ header: string; lines: string[] }>;
}

export interface SessionDisplayStep {
  tool: string;
  target: string;
  status: 'done' | 'failed';
  output?: string | undefined;
}

export type SessionDisplayBlock =
  | { kind: 'reasoning'; content: string }
  | { kind: 'steps'; steps: SessionDisplayStep[] }
  | { kind: 'text'; content: string };

export interface SessionDisplayMessage {
  role: 'user' | 'assistant';
  content: string;
  reasoning?: string | undefined;
  steps?: SessionDisplayStep[] | undefined;
  blocks?: SessionDisplayBlock[] | undefined;
}

export interface SessionActiveRun {
  key: string;
  sessionId: string | null;
  taskId: string;
  prompt: string;
  startedAt: number;
  status: 'running' | 'awaiting_client' | 'completed' | 'stopped' | 'errored';
  userStopped: boolean;
  loop: SkybridgeLoopLike;
  frames: string[];
  bufferedBytes: number;
  subscribers: Set<(frame: string) => void>;
  doneSubscribers: Set<() => void>;
}

export interface BrowserAgentActivity {
  active: boolean;
  tool: string;
  detail: string;
  updatedAt: number;
}

export interface SkybridgeContext {
  readonly workspaceRoot: string;
  readonly version: string;
  readonly token: string;
  readonly hasCustomFactory: boolean;
  readonly entitlementClient?: SkybridgeEntitlementClientLike | undefined;
  readonly loopFactory: SkybridgeLoopFactory;
  readonly serverApprovalScope: ReturnType<typeof createApprovalScope>;
  readonly activeRuns: Map<string, SessionActiveRun>;
  readonly sessionTouchedFilesMap: Map<string, Set<string>>;
  readonly browserStreamClients: Set<(payload: Record<string, unknown>) => void>;
  getBoundPort(): number;
  nextTaskId(): string;
  findActiveRun(sessionId?: string | null): SessionActiveRun | null;
  pushRunFrame(run: SessionActiveRun, raw: string): void;
  attachRunStream(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    run: SessionActiveRun,
    replayBuffered: boolean
  ): void;
  recordSessionTouchedFile(sessionId: string | null | undefined, rawPath: unknown): void;
  getBrowserControlOwner(): 'human' | 'agent';
  setBrowserControlOwner(owner: 'human' | 'agent'): void;
  getBrowserAgentActivity(): BrowserAgentActivity;
  setBrowserAgentActivity(activity: BrowserAgentActivity): void;
  broadcastBrowserNotice(payload: Record<string, unknown>): void;
}
