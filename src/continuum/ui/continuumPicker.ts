// Continuum TUI Picker: interactive modal dialog for browsing and adopting peer agent sessions.
// Authorship: Strict TypeScript (Causyne Agent).

// @ts-expect-error untyped local TUI dialogs
import { SelectLayer, TextLayer } from '../../tui/dialogs.js';
// @ts-expect-error untyped local TUI theme
import { GLYPHS } from '../../tui/theme.js';
import type { ContinuumSessionSummary } from '../types.js';
import { ContinuumScanner } from '../scanner.js';
import { adoptContinuumSession } from '../ingest.js';

function formatTimeAgo(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  const minutes = Math.floor(diffMs / (60 * 1000));
  if (minutes < 60) return `${Math.max(1, minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function buildContinuumItems(sessions: ContinuumSessionSummary[]) {
  return sessions.map(s => {
    const timeAgo = formatTimeAgo(s.updatedAt);
    const ws = s.workspacePath ? s.workspacePath.split('/').pop() || s.workspacePath : '';
    const desc = `${s.messageCount} msg${s.messageCount === 1 ? '' : 's'}  ${GLYPHS.dot}  ${timeAgo}${ws ? `  ${GLYPHS.dot}  ${ws}` : ''}`;

    return {
      label: s.title,
      description: desc,
      category: s.sourceLabel,
      hint: s.sourceLabel,
      searchText: `${s.sourceLabel} ${s.title} ${s.workspacePath} ${s.snippet}`,
      value: s
    };
  });
}

/**
 * Launch the interactive Continuum session picker.
 */
export async function runInteractiveContinuum(
  prompt: { openLayer: (layer: unknown) => void; closeLayer?: () => void },
  options: {
    scanner?: ContinuumScanner;
    loop?: {
      taskId?: string;
      messages: Array<{ role: string; content?: unknown }>;
      memoryManager?: {
        useSession: (id: string) => unknown;
        loadHistory?: () => Array<{ role: string; content?: unknown }>;
      };
    };
  } = {}
): Promise<string> {
  const scanner = options.scanner || new ContinuumScanner();
  const sessions = await scanner.scanAllSessions({ limit: 80 });

  if (sessions.length === 0) {
    return 'No peer agent sessions found across Antigravity, OpenCode, Codex, or Claude Code on this machine.';
  }

  const items = buildContinuumItems(sessions);

  const pickedSession = await new Promise<ContinuumSessionSummary | null>((resolve) => {
    const layer = new SelectLayer({
      title: `Continuum · Cross-Agent Sessions (${sessions.length})`,
      placeholder: 'search past agent conversations (antigravity, opencode, codex, claude)...',
      emptyText: 'no matching sessions found',
      width: 78,
      height: 20,
      footer: `enter adopt session  ${GLYPHS.dot}  esc cancel`,
      items,
      onPick: (item: { value: ContinuumSessionSummary } | null) => {
        resolve(item ? item.value : null);
      }
    });
    prompt.openLayer(layer);
  });

  if (!pickedSession) {
    return 'Cancelled. Session was not changed.';
  }

  // Ingest the chosen session
  const adoptRes = await adoptContinuumSession(pickedSession.id, {
    scanner,
    currentLoopMessages: options.loop?.messages
  });

  if (!adoptRes.ok) {
    return `Failed to adopt session: ${adoptRes.error}`;
  }

  if (options.loop) {
    options.loop.taskId = `cli_chat_${Date.now()}`;
    if (options.loop.memoryManager) {
      options.loop.memoryManager.useSession(adoptRes.sessionId);
      if (typeof options.loop.memoryManager.loadHistory === 'function') {
        options.loop.messages = options.loop.memoryManager.loadHistory();
      }
    }
    const renderer = (prompt as any).renderer || (options.loop as any)?.connection?.renderer;
    if (renderer && typeof renderer.renderSessionHistory === 'function') {
      renderer.renderSessionHistory(options.loop.messages || [], {
        id: adoptRes.sessionId,
        title: adoptRes.title,
        messagesCount: adoptRes.messageCount
      });
    }
    if ((prompt as any).surface?.viewport && typeof (prompt as any).surface.viewport.toBottom === 'function') {
      (prompt as any).surface.viewport.toBottom();
    }
  }

  if ((prompt as any).editor && typeof (prompt as any).editor.clear === 'function') {
    (prompt as any).editor.clear();
    if (typeof (prompt as any).scheduleDraw === 'function') (prompt as any).scheduleDraw();
  }

  return `Successfully adopted session "${adoptRes.title}" from ${adoptRes.sourcePlatform.toUpperCase()} (${adoptRes.messageCount} messages compacted).\nActive Causyne session: ${adoptRes.sessionId}.`;
}

/**
 * Open a preview text modal showing the full conversation transcript for a session.
 */
export async function openContinuumPreview(
  sessionId: string,
  prompt: { openLayer: (layer: unknown) => void },
  scanner?: ContinuumScanner
): Promise<boolean> {
  const sc = scanner || new ContinuumScanner();
  const detail = await sc.fetchSession(sessionId);

  if (!detail || !detail.messages) {
    return false;
  }

  const lines: string[] = [
    `Source: ${detail.sourceLabel} · Messages: ${detail.messages.length} · Workspace: ${detail.workspacePath || '(default)'}`,
    '─'.repeat(70),
    ''
  ];

  for (const msg of detail.messages) {
    const rolePrefix = msg.role === 'user' ? '👤 USER' : '🤖 ASSISTANT';
    lines.push(`${rolePrefix}:`);
    for (const textLine of msg.content.split('\n')) {
      lines.push(`  ${textLine}`);
    }
    lines.push('');
  }

  const layer = new TextLayer({
    title: `Preview: ${detail.title}`,
    lines,
    width: 76,
    height: 22
  });

  prompt.openLayer(layer);
  return true;
}
