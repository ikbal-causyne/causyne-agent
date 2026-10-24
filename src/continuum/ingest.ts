// Continuum Ingestion Engine: adopts peer agent sessions into Causyne's native journal.
// Authorship: Strict TypeScript (Causyne Agent).

import type { ContinuumAdoptResult, ContinuumSessionDetail } from './types.js';
import { ContinuumScanner } from './scanner.js';
import { compactContinuumMessages } from './compactor.js';
import {
  createSession,
  saveSessionMessages,
  getActiveSessionId,
  getSession,
  setActiveSession,
  type SessionMessage
} from '../sessionJournal.js';

export interface IngestOptions {
  workspace?: string | undefined;
  scanner?: ContinuumScanner | undefined;
  currentLoopMessages?: Array<{ role: string; content?: unknown }> | undefined;
}

/**
 * Safely adopt an external agent's session into Causyne's active session journal.
 * Automatically saves and checkpoints any existing active session so no data is ever lost.
 */
export async function adoptContinuumSession(
  target: string | ContinuumSessionDetail,
  options: IngestOptions = {}
): Promise<ContinuumAdoptResult> {
  let detail: ContinuumSessionDetail | null = null;
  let targetId = typeof target === 'string' ? target : target.id;

  if (typeof target === 'string') {
    const scanner = options.scanner || new ContinuumScanner();
    detail = await scanner.fetchSession(target);
  } else {
    detail = target;
  }

  if (!detail || !detail.messages || detail.messages.length === 0) {
    return {
      ok: false,
      sessionId: targetId,
      title: 'Unknown',
      sourcePlatform: 'antigravity',
      messageCount: 0,
      error: `Could not load session "${targetId}". It may have been moved or removed.`
    };
  }

  // 1. Checkpoint current active session if it holds unsaved messages
  const currentActiveId = getActiveSessionId();
  if (currentActiveId && options.currentLoopMessages && options.currentLoopMessages.length > 0) {
    const existing = getSession(currentActiveId);
    if (existing) {
      saveSessionMessages(currentActiveId, options.currentLoopMessages as SessionMessage[]);
    }
  }

  // 2. Compact messages & inject Continuum handshake anchor
  const compacted = compactContinuumMessages(detail.messages, {
    platform: detail.sourcePlatform,
    sourceTitle: detail.title,
    originalWorkspace: detail.workspacePath
  });

  // 3. Create a new sovereign Causyne session
  const targetWorkspace = options.workspace || process.cwd();
  const title = `[Adopted] ${detail.title}`;
  const newSession = createSession(targetWorkspace, title, true);

  // 4. Ingest compacted messages into journal
  const sessionMessages: SessionMessage[] = compacted.map(m => ({
    role: m.role,
    content: m.content
  }));

  saveSessionMessages(newSession.id, sessionMessages);
  setActiveSession(newSession.id);

  return {
    ok: true,
    sessionId: newSession.id,
    title: newSession.title,
    sourcePlatform: detail.sourcePlatform,
    messageCount: sessionMessages.length,
    preservedActiveSessionId: currentActiveId
  };
}
