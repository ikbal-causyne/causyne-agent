// Sovereign Interactive Session Picker — modal dialog for listing, switching, and creating sessions.
// Authored in Strict TypeScript for Causyne Agent.
// Source-available under BUSL-1.1.

// @ts-expect-error untyped local TUI dialogs
import { SelectLayer } from './dialogs.js';
// @ts-expect-error untyped local TUI theme
import { GLYPHS } from './theme.js';
import {
  listSessions,
  getActiveSessionId,
  switchSession,
  createSession,
  type SessionRecord
} from '../sessionJournal.js';

export interface SessionPickerItemValue {
  type: 'new' | 'switch';
  id?: string | undefined;
  title?: string | undefined;
  workspace?: string | undefined;
  messageCount?: number | undefined;
  isCurrent?: boolean | undefined;
}

export interface SessionPickerItem {
  id: string;
  label: string;
  category: string;
  description: string;
  searchText?: string;
  value: SessionPickerItemValue;
}

export interface InteractiveSessionPickerOptions {
  loop?: {
    taskId?: string;
    messages?: Array<{ role: string; content?: unknown }>;
    tokenTracker?: { reset?: () => void; sessionTokens?: number };
    memoryManager?: {
      startNewSession?: (title?: string) => any;
      useSession?: (id: string) => any;
      loadHistory?: () => Array<{ role: string; content?: unknown }>;
      sessionId?: string | null;
      session?: any;
    };
  } | undefined;
  workspace?: string | undefined;
}

function formatTimeAgo(timestamp: number): string {
  const diffMs = Date.now() - timestamp;
  const minutes = Math.floor(diffMs / (60 * 1000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / (60 * 60 * 1000));
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / (24 * 60 * 60 * 1000));
  return `${days}d ago`;
}

function shortenPath(p: string | undefined): string {
  if (!p) return '(default)';
  const home = process.env.HOME || '';
  if (home && p.startsWith(home)) {
    return '~' + p.slice(home.length);
  }
  return p.split('/').pop() || p;
}

/**
 * Build item list for SelectLayer modal.
 * The top item is always "+ New Session" to guarantee clean separation and quick reset.
 */
export function buildSessionPickerItems(
  sessions: Array<Omit<SessionRecord, 'messages'> & { messageCount: number }>,
  activeId: string | null,
  currentWorkspace: string
): SessionPickerItem[] {
  const items: SessionPickerItem[] = [];

  // Pinned item 0: Create new clean conversation
  items.push({
    id: '__NEW_SESSION__',
    label: '+ New Session (Start fresh conversation)',
    category: 'Actions',
    description: 'Begin a clean session in this workspace without previous context',
    searchText: 'new session fresh clear reset start',
    value: {
      type: 'new'
    }
  });

  for (const s of sessions) {
    const isCurrent = s.id === activeId;
    const timeAgo = formatTimeAgo(s.updatedAt);
    const wsLabel = shortenPath(s.workspace);
    const msgCount = `${s.messageCount} msg${s.messageCount === 1 ? '' : 's'}`;

    let category = 'Other Workspaces';
    if (s.workspace === currentWorkspace || !s.workspace) {
      category = 'Current Workspace';
    }
    if (s.title.startsWith('[Adopted]')) {
      category = 'Continuum (Peer Agent)';
    }

    const mark = isCurrent ? `● ` : `  `;
    const tag = isCurrent ? ` [active]` : '';

    items.push({
      id: s.id,
      label: `${mark}${s.title}${tag}`,
      category,
      description: `${msgCount}  ${GLYPHS.dot}  ${timeAgo}  ${GLYPHS.dot}  ${wsLabel}  ${GLYPHS.dot}  ${s.id}`,
      searchText: `${s.title} ${s.id} ${s.workspace || ''} ${category}`,
      value: {
        type: 'switch',
        id: s.id,
        title: s.title,
        workspace: s.workspace,
        messageCount: s.messageCount,
        isCurrent
      }
    });
  }

  return items;
}

/**
 * Launch the interactive Session Picker modal.
 * Single Enter switches session or creates a new one immediately.
 */
export async function runInteractiveSessionPicker(
  prompt: {
    openLayer: (layer: unknown) => void;
    editor?: { clear: () => void };
    scheduleDraw?: () => void;
    updateModel?: (provider?: string, model?: string) => void;
    renderer?: { status?: { setSession: (info: any) => void } };
  },
  options: InteractiveSessionPickerOptions = {}
): Promise<string> {
  const workspace = options.workspace || process.cwd();
  const sessions = listSessions();
  const activeId = getActiveSessionId();

  const items = buildSessionPickerItems(sessions, activeId, workspace);

  const cleanPrompt = () => {
    if (prompt.editor && typeof prompt.editor.clear === 'function') {
      prompt.editor.clear();
      if (typeof prompt.scheduleDraw === 'function') prompt.scheduleDraw();
    }
  };

  const picked = await new Promise<SessionPickerItem | null>((resolve) => {
    const layer = new SelectLayer({
      title: `Sessions · Manage & Switch Conversations (${sessions.length})`,
      placeholder: 'search sessions by title, id, or workspace...',
      emptyText: 'no matching sessions found',
      width: 78,
      height: 20,
      footer: `enter select session  ${GLYPHS.dot}  esc cancel`,
      items,
      onPick: (item: SessionPickerItem | null) => {
        resolve(item || null);
      }
    });
    prompt.openLayer(layer);
  });

  cleanPrompt();

  if (!picked || !picked.value) {
    return 'Cancelled. Session was not changed.';
  }

  // Case 1: Start fresh new session
  if (picked.value.type === 'new') {
    let newSession: SessionRecord;
    if (options.loop?.memoryManager && typeof options.loop.memoryManager.startNewSession === 'function') {
      newSession = options.loop.memoryManager.startNewSession('Untitled');
    } else {
      newSession = createSession(workspace, 'Untitled', true);
    }

    if (options.loop) {
      options.loop.messages = [];
      options.loop.taskId = `cli_chat_${Date.now()}`;
      if (options.loop.tokenTracker && typeof options.loop.tokenTracker.reset === 'function') {
        options.loop.tokenTracker.reset();
      }
    }

    cleanPrompt();
    return `Started new session: "${newSession.title}" (${newSession.id}) in ${shortenPath(workspace)}.`;
  }

  // Case 2: Switch to selected session
  const targetId = picked.value.id;
  if (!targetId) {
    return 'Cancelled. No session selected.';
  }

  if (targetId === activeId) {
    cleanPrompt();
    return `Already active in session "${picked.value.title || targetId}".`;
  }

  let switched: SessionRecord | null = null;
  if (options.loop?.memoryManager && typeof options.loop.memoryManager.useSession === 'function') {
    switched = options.loop.memoryManager.useSession(targetId);
  } else {
    switched = switchSession(targetId);
  }

  if (!switched) {
    cleanPrompt();
    return `⚠️ Could not switch to session "${targetId}". File may have been removed.`;
  }

  if (options.loop) {
    if (options.loop.memoryManager && typeof options.loop.memoryManager.loadHistory === 'function') {
      options.loop.messages = options.loop.memoryManager.loadHistory();
    } else {
      options.loop.messages = switched.messages.filter(m => m.role !== 'system');
    }
    options.loop.taskId = `cli_chat_${Date.now()}`;
    if (options.loop.tokenTracker && typeof options.loop.tokenTracker.reset === 'function') {
      options.loop.tokenTracker.reset();
    }
  }

  cleanPrompt();
  return `✓ Switched to "${switched.title}" (${switched.messages.length} messages, ${switched.id}).`;
}
