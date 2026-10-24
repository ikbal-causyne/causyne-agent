export interface ChatFrame {
  kind: string;
  meta?: Record<string, unknown> | null;
}

export interface ChatTranscript {
  frames: ChatFrame[];
}

export class ChatRenderer {
  constructor(options?: Record<string, unknown>);
  transcript: ChatTranscript | null;
  _activeReasoning?: boolean;
  handle(message: { type: string; [key: string]: unknown }): boolean;
  onAgentReasoning(message: { content?: string; streaming?: boolean; elapsedMs?: number }): void;
  stopSpinner(): void;
  frame(kind: string, produce: () => void, meta?: Record<string, unknown> | null): void;
  updateTailFrame(kind: string, produce: () => void, meta?: Record<string, unknown> | null): void;
  measure(): number;
  write(line?: string): void;
}
