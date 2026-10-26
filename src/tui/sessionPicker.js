// Sovereign Interactive Session Picker — modal dialog for listing, switching, and creating sessions.
// Authored in Strict TypeScript for Causyne Agent.
// Source-available under BUSL-1.1.
// @ts-expect-error untyped local TUI dialogs
import { SelectLayer } from './dialogs.js';
// @ts-expect-error untyped local TUI theme
import { GLYPHS } from './theme.js';
import { listSessions, getActiveSessionId, switchSession, createSession, forkSession } from '../sessionJournal.js';
import { revokeAllAlways } from '../approvalGrants.js';
/** The divider counts conversation turns that the history renderer can show. */
function visibleHistoryCount(messages) {
    return messages.filter((message) => {
        if (message.role !== 'user' && message.role !== 'assistant')
            return false;
        if (typeof message.content === 'string')
            return message.content.trim().length > 0;
        if (Array.isArray(message.content)) {
            return message.content.some((part) => typeof part === 'string' && part.trim().length > 0
                || !!part && typeof part === 'object' && 'text' in part
                    && typeof part.text === 'string' && part.text.trim().length > 0);
        }
        return false;
    }).length;
}
function formatTimeAgo(timestamp) {
    const diffMs = Math.max(0, Date.now() - timestamp);
    const minutes = Math.floor(diffMs / (60 * 1000));
    if (minutes < 1)
        return 'just now';
    if (minutes < 60)
        return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24)
        return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}
function dateGroup(timestamp) {
    const date = new Date(timestamp);
    if (!Number.isFinite(date.getTime()))
        return 'Unknown date';
    const today = new Date();
    if (date.toDateString() === today.toDateString())
        return 'Today';
    const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
    return date.toDateString() === yesterday.toDateString() ? 'Yesterday' : date.toDateString();
}
function shortenPath(p) {
    if (!p)
        return '(default)';
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
export function buildSessionPickerItems(sessions, activeId, currentWorkspace) {
    const items = [];
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
    // Pinned item 1: Fork active conversation if available
    if (activeId) {
        const active = sessions.find(s => s.id === activeId);
        if (active) {
            items.push({
                id: '__FORK_SESSION__',
                label: `Branch / Fork Current Session ("${active.title}")`,
                category: 'Actions',
                description: 'Copy conversation history into a new branch without copying permissions',
                searchText: 'fork branch clone copy session fresh permissions',
                value: {
                    type: 'fork',
                    id: activeId,
                    title: active.title
                }
            });
        }
    }
    for (const s of [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)) {
        // A session without any turns has no conversation to resume. Keep the
        // active one available, but do not fill the picker with abandoned starts.
        if (s.messageCount === 0 && s.id !== activeId)
            continue;
        const isCurrent = s.id === activeId;
        const timeAgo = formatTimeAgo(s.updatedAt);
        const wsLabel = shortenPath(s.workspace);
        const msgCount = `${s.messageCount} msg${s.messageCount === 1 ? '' : 's'}`;
        const category = dateGroup(s.updatedAt);
        const mark = isCurrent ? `● ` : `  `;
        const tag = isCurrent ? ` [active]` : '';
        items.push({
            id: s.id,
            label: `${mark}${s.title}${tag}`,
            category,
            description: `${msgCount}  ${GLYPHS.dot}  ${timeAgo}  ${GLYPHS.dot}  ${wsLabel}${s.workspace === currentWorkspace ? ' (current)' : ''}`,
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
export async function runInteractiveSessionPicker(prompt, options = {}) {
    const workspace = options.workspace || process.cwd();
    const sessions = listSessions();
    const activeId = getActiveSessionId();
    const items = buildSessionPickerItems(sessions, activeId, workspace);
    const conversationCount = items.filter(item => item.value.type === 'switch').length;
    const cleanPrompt = () => {
        if (prompt.editor && typeof prompt.editor.clear === 'function') {
            prompt.editor.clear();
            if (typeof prompt.scheduleDraw === 'function')
                prompt.scheduleDraw();
        }
    };
    const picked = await new Promise((resolve) => {
        const layer = new SelectLayer({
            title: `Sessions (${conversationCount})`,
            placeholder: 'search sessions by title, id, or workspace...',
            emptyText: 'no matching sessions found',
            width: 78,
            height: 20,
            footer: `enter select session  ${GLYPHS.dot}  esc cancel`,
            items,
            onPick: (item) => {
                resolve(item || null);
            }
        });
        // Opening the picker should highlight a conversation, not an action that
        // creates a new one. Actions remain available above the dated list.
        const selected = items.findIndex(item => item.id === activeId);
        const firstConversation = items.findIndex(item => item.value.type === 'switch');
        layer.list.moveTo(selected >= 0 ? selected : Math.max(0, firstConversation), 15);
        prompt.openLayer(layer);
    });
    cleanPrompt();
    if (!picked || !picked.value) {
        return 'Cancelled. Session was not changed.';
    }
    // Case 1: Start fresh new session
    if (picked.value.type === 'new') {
        let newSession;
        if (options.loop?.memoryManager && typeof options.loop.memoryManager.startNewSession === 'function') {
            newSession = options.loop.memoryManager.startNewSession('Untitled');
        }
        else {
            newSession = createSession(workspace, 'Untitled', true);
        }
        if (options.loop) {
            options.loop.messages = [];
            options.loop.taskId = `cli_chat_${Date.now()}`;
            if (options.loop.tokenTracker && typeof options.loop.tokenTracker.reset === 'function') {
                options.loop.tokenTracker.reset();
            }
        }
        const renderer = prompt.renderer || options.loop?.connection?.renderer;
        if (renderer && typeof renderer.renderSessionHistory === 'function') {
            renderer.renderSessionHistory([], {
                id: newSession.id,
                title: newSession.title,
                messagesCount: 0
            });
        }
        if (prompt.surface?.viewport && typeof prompt.surface.viewport.toBottom === 'function') {
            prompt.surface.viewport.toBottom();
        }
        cleanPrompt();
        return `Started new session: "${newSession.title}" (${newSession.id}) in ${shortenPath(workspace)}.`;
    }
    // Case 2: Fork session into a new branch without copying permissions
    if (picked.value.type === 'fork') {
        const sourceId = picked.value.id || activeId;
        if (!sourceId) {
            return 'Cancelled. No session to fork.';
        }
        let forked = null;
        if (options.loop?.memoryManager && typeof options.loop.memoryManager.forkSession === 'function') {
            forked = options.loop.memoryManager.forkSession();
        }
        else {
            forked = forkSession(sourceId, { makeActive: true });
        }
        if (!forked) {
            cleanPrompt();
            return `Could not fork session "${sourceId}".`;
        }
        // CRITICAL SECURITY INVARIANT (Claude Code Architecture, p. 24):
        // Permissions and allowlists MUST NOT be copied across the fork.
        revokeAllAlways();
        if (options.loop && typeof options.loop.resetApprovalScope === 'function') {
            options.loop.resetApprovalScope();
        }
        const historyMessages = options.loop?.memoryManager && typeof options.loop.memoryManager.loadHistory === 'function'
            ? options.loop.memoryManager.loadHistory()
            : forked.messages.filter(m => m.role !== 'system');
        if (options.loop) {
            options.loop.messages = historyMessages;
            options.loop.taskId = `cli_chat_${Date.now()}`;
            if (options.loop.tokenTracker && typeof options.loop.tokenTracker.reset === 'function') {
                options.loop.tokenTracker.reset();
            }
        }
        const renderer = prompt.renderer || options.loop?.connection?.renderer;
        if (renderer && typeof renderer.renderSessionHistory === 'function') {
            renderer.renderSessionHistory(historyMessages, {
                id: forked.id,
                title: forked.title,
                messagesCount: visibleHistoryCount(historyMessages)
            });
        }
        if (prompt.surface?.viewport && typeof prompt.surface.viewport.toBottom === 'function') {
            prompt.surface.viewport.toBottom();
        }
        cleanPrompt();
        return `Forked into "${forked.title}" (${forked.messages.length} messages, ${forked.id}). Permissions and standing approvals were reset; any gated actions will request authorization anew.`;
    }
    // Case 3: Switch to selected session
    const targetId = picked.value.id;
    if (!targetId) {
        return 'Cancelled. No session selected.';
    }
    let switched = null;
    if (options.loop?.memoryManager && typeof options.loop.memoryManager.useSession === 'function') {
        switched = options.loop.memoryManager.useSession(targetId);
    }
    else {
        switched = switchSession(targetId);
    }
    if (!switched) {
        cleanPrompt();
        return `⚠️ Could not switch to session "${targetId}". File may have been removed.`;
    }
    const historyMessages = options.loop?.memoryManager && typeof options.loop.memoryManager.loadHistory === 'function'
        ? options.loop.memoryManager.loadHistory()
        : switched.messages.filter(m => m.role !== 'system');
    if (options.loop) {
        options.loop.messages = historyMessages;
        options.loop.taskId = `cli_chat_${Date.now()}`;
        if (options.loop.tokenTracker && typeof options.loop.tokenTracker.reset === 'function') {
            options.loop.tokenTracker.reset();
        }
    }
    // Render the conversation history to the transcript & viewport
    const renderer = prompt.renderer || options.loop?.connection?.renderer;
    if (renderer && typeof renderer.renderSessionHistory === 'function') {
        renderer.renderSessionHistory(historyMessages, {
            id: switched.id,
            title: switched.title,
            messagesCount: visibleHistoryCount(historyMessages)
        });
    }
    if (prompt.surface?.viewport && typeof prompt.surface.viewport.toBottom === 'function') {
        prompt.surface.viewport.toBottom();
    }
    cleanPrompt();
    return `Switched to "${switched.title}" (${switched.messages.length} messages, ${switched.id}).`;
}
