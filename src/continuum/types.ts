// Sovereign Cross-Agent Continuum Engine: Unified Session Types & Contracts.
// Authorship: Strict TypeScript (Causyne Agent).

export type AgentPlatform = 'antigravity' | 'opencode' | 'codex' | 'claude_code' | 'causyne' | 'cursor';

export interface ContinuumMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp?: number;
  metadata?: Record<string, unknown>;
}

export interface ContinuumSessionSummary {
  id: string;
  sourcePlatform: AgentPlatform;
  sourceLabel: string;
  title: string;
  workspacePath: string;
  updatedAt: number;
  messageCount: number;
  snippet: string;
}

export interface ContinuumSessionDetail extends ContinuumSessionSummary {
  messages: ContinuumMessage[];
}

export interface ContinuumAdapter {
  readonly platform: AgentPlatform;
  readonly label: string;
  isAvailable(): boolean;
  listSessions(limit?: number): Promise<ContinuumSessionSummary[]>;
  getSession(id: string): Promise<ContinuumSessionDetail | null>;
}

export interface ContinuumFilterOptions {
  platform?: AgentPlatform | 'all';
  query?: string;
  limit?: number;
  workspaceFilter?: string;
}

export interface ContinuumAdoptResult {
  ok: boolean;
  sessionId: string;
  title: string;
  sourcePlatform: AgentPlatform;
  messageCount: number;
  preservedActiveSessionId?: string | null;
  error?: string;
}
