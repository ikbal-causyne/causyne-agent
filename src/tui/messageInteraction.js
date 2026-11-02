import { getActiveSessionId, getSession, listSessions, saveSessionMessages } from '../sessionJournal.js';
import { revokeAllAlways } from '../approvalGrants.js';
// @ts-expect-error Legacy checkpoints module has no TypeScript declarations yet.
import { undoLast } from '../checkpoints.js';
import { writeClipboardSync } from './clipboardSync.js';
import { registerStageConsoleGuard, setTransientNotice } from './consoleGuard.js';
import { detectLinkAtPoint, openDetectedLink } from './smartLinkClick.js';
import { sidebarVisible, sessionMainWidth } from './sessionSidebar.js';
import { stripAnsi, truncate, padEnd } from './text.js';
// @ts-expect-error Legacy overlay has no declaration yet.
import { Layer } from './overlay.js';
// @ts-expect-error Legacy theme has no declaration yet.
import { paint, bold, fill } from './theme.js';
/** Multi-action message menu overlay supporting Copy, Fork, and Revert. */
export class MessageActionsLayer extends Layer {
    messageActions = true;
    actionLayout = null;
    anchorY;
    items;
    list;
    onPick;
    settled = false;
    constructor(items, onPick, anchorY = null) {
        super({ title: 'Message Actions', width: 68, height: items.length + 2, footer: '↑↓ move  ·  enter select  ·  esc close' });
        this.items = items;
        this.onPick = onPick;
        this.anchorY = anchorY;
        this.list = {
            filtered: items,
            selected: 0,
            moveTo: (index) => { this.list.selected = Math.max(0, Math.min(items.length - 1, index)); }
        };
    }
    preferredHeight() { return this.items.length + 2; }
    body(width) {
        return this.items.map((item, index) => {
            const selected = index === this.list.selected;
            const label = `${selected ? '▸' : ' '} ${item.label}`;
            const description = `  ${item.description}`;
            const room = Math.max(0, width - description.length);
            const content = `${truncate(label, room, '…')}${description}`;
            return selected ? paint('accent', bold(truncate(content, width, '…'))) : paint('ink', truncate(content, width, '…'));
        });
    }
    key(event) {
        if (event.name === 'escape') {
            this.settled = true;
            this.onPick(null);
            return 'close';
        }
        if (event.name === 'up' || event.name === 'down') {
            const delta = event.name === 'up' ? -1 : 1;
            this.list.moveTo((this.list.selected + delta + this.items.length) % this.items.length);
            return 'handled';
        }
        if (event.name === 'enter' || event.name === 'return') {
            this.settled = true;
            this.onPick(this.items[this.list.selected] ?? null);
            return 'close';
        }
        if (!event.ctrl && !event.alt && (event.name.length === 1 || event.name === 'space' || event.name === 'backspace')) {
            this.settled = true;
            this.onPick(null);
            return 'dismiss';
        }
        return 'handled';
    }
    answer() {
        if (!this.settled) {
            this.settled = true;
            this.onPick(null);
        }
    }
}
export function isMouseMotion(sequence) {
    const code = Number(/^\x1b\[<(\d+);/.exec(sequence || '')?.[1]);
    return Number.isFinite(code) && (code & 32) !== 0;
}
export function handleMessageMouse(host, loop, event) {
    const mouse = event.mouse;
    const surface = host.surface;
    if (!mouse || !surface)
        return false;
    const marker = messageAt(surface, mouse);
    if (surface.hoveredMessageFrameId !== (marker?.id ?? null)) {
        surface.hoveredMessageFrameId = marker?.id ?? null;
        host.scheduleDraw();
    }
    // SGR motion carries bit 32; it must update hover without opening the menu.
    if (isMouseMotion(event.sequence))
        return true;
    if (mouse.button === 0 && mouse.pressed) {
        // Smart link detection: if the user clicked (or Cmd/Ctrl+Clicked) on a URL or OSC 8 hyperlink,
        // open the link directly in the system browser instead of popping up the Message Actions modal.
        const hitLink = detectLinkAtPoint(surface, mouse, marker);
        if (hitLink) {
            openDetectedLink(hitLink.url);
            writeClipboardSync(hitLink.url);
            surface.hoveredMessageFrameId = null;
            setTransientNotice(host, `Opened ${hitLink.url}`);
            return true;
        }
        // Never open Message Actions on a modifier click (Ctrl/Alt/Shift+Click) that missed a link by 1 cell.
        if (event.ctrl || event.alt || event.shift) {
            return true;
        }
        if (marker) {
            openMessageActions(host, loop, marker, mouse.y);
        }
    }
    return true;
}
const isMessage = (marker) => (marker.kind === 'user' || marker.kind === 'assistant')
    && typeof marker.meta?.messageText === 'string';
/** Resolve screen coordinates against the painted viewport, including top padding. */
export function messageAt(surface, point) {
    if (!surface?.stage.reserved || !Number.isFinite(point.x) || !Number.isFinite(point.y))
        return null;
    const mainWidth = sidebarVisible(surface.width) ? sessionMainWidth(surface.width) : surface.width;
    const leftGutter = (surface.turnRailLayout?.turns?.length ?? 0) > 0 ? 3 : 0;
    if (point.x < leftGutter || point.x >= Math.min(mainWidth, surface.viewport.width))
        return null;
    const top = Math.max(0, (surface.out.rows || surface.stage.height) - surface.stage.height);
    const viewRow = point.y - top;
    if (viewRow < 0 || viewRow >= surface.viewport.height)
        return null;
    const flat = surface.transcript.flatten(surface.viewport.width);
    const visible = Math.max(0, Math.min(surface.viewport.height, flat.rows.length - surface.viewport.scrollTop));
    const padding = surface.viewport.height - visible;
    if (viewRow < padding)
        return null;
    const row = surface.viewport.scrollTop + viewRow - padding;
    for (let i = flat.markers.length - 1; i >= 0; i--) {
        const marker = flat.markers[i];
        if (!marker || marker.row > row)
            continue;
        const next = flat.markers[i + 1];
        if (isMessage(marker) && row < (next?.row ?? flat.rows.length))
            return marker;
        return null;
    }
    return null;
}
/** Highlight only the visible non-empty rows of the hovered message, without altering transcript data. */
export function markHoveredMessage(rows, surface, contentWidth) {
    registerStageConsoleGuard(surface);
    const id = surface.hoveredMessageFrameId;
    if (!id)
        return;
    const flat = surface.transcript.flatten(contentWidth);
    const marker = flat.markers.find(item => item.id === id);
    if (!marker || !isMessage(marker))
        return;
    const visible = Math.max(0, Math.min(rows.length, flat.rows.length - surface.viewport.scrollTop));
    const padding = rows.length - visible;
    const next = flat.markers[flat.markers.indexOf(marker) + 1];
    const rawStart = marker.row;
    const rawEnd = next?.row ?? flat.rows.length;
    // Skip leading and trailing blank separator lines inside the message frame
    // so we never paint a stray '▸' on an empty spacing row above '▸ Causyne'.
    let firstContentRow = rawStart;
    while (firstContentRow < rawEnd && stripAnsi(flat.rows[firstContentRow] ?? '').trim() === '') {
        firstContentRow++;
    }
    let lastContentRow = rawEnd - 1;
    while (lastContentRow > firstContentRow && stripAnsi(flat.rows[lastContentRow] ?? '').trim() === '') {
        lastContentRow--;
    }
    if (firstContentRow >= rawEnd)
        return;
    const first = Math.max(firstContentRow, surface.viewport.scrollTop);
    const last = Math.min(lastContentRow + 1, surface.viewport.scrollTop + visible);
    for (let transcriptRow = first; transcriptRow < last; transcriptRow++) {
        const row = transcriptRow - surface.viewport.scrollTop + padding;
        if (row < padding || row >= rows.length)
            continue;
        const existingRow = rows[row] ?? '';
        const plainTrimmed = stripAnsi(existingRow).trimStart();
        const alreadyHasMarker = plainTrimmed.startsWith('▸') || plainTrimmed.startsWith('│');
        const content = transcriptRow === firstContentRow && !alreadyHasMarker
            ? `${paint('accent', '▸')} ${truncate(existingRow, Math.max(0, contentWidth - 2), '')}`
            : existingRow;
        rows[row] = fill('surfaceHi', padEnd(content, contentWidth));
    }
}
function messageText(content) {
    if (typeof content === 'string')
        return content;
    if (Array.isArray(content))
        return content.map(part => typeof part === 'string' ? part : part && typeof part === 'object' && 'text' in part
            ? String(part.text) : '').filter(Boolean).join('\n');
    return '';
}
function messagesMatch(persistedContent, shownText) {
    if (typeof shownText !== 'string')
        return false;
    const persisted = messageText(persistedContent);
    if (persisted === shownText)
        return true;
    const cleanPersisted = persisted.trim();
    const cleanShown = shownText.trim();
    if (!cleanShown)
        return false;
    if (cleanPersisted === cleanShown)
        return true;
    // Handle messages where an attachment system notification was appended on save
    if (cleanPersisted.startsWith(cleanShown))
        return true;
    return false;
}
/** Match in conversation order; never guess a fork point from visual row alone. */
export function persistedMessageIndex(marker, markers, messages) {
    let matched = -1;
    for (const shown of markers) {
        if (!isMessage(shown))
            continue;
        let found = -1;
        for (let i = matched + 1; i < messages.length; i++) {
            const message = messages[i];
            if (message?.role === shown.kind && messagesMatch(message.content, shown.meta?.messageText)) {
                found = i;
                break;
            }
        }
        if (found >= 0)
            matched = found;
        if (shown.id === marker.id)
            return found >= 0 ? found : null;
    }
    return null;
}
function computeNextForkTitle(sourceTitle) {
    const cleanBase = (sourceTitle && sourceTitle !== 'Untitled' ? sourceTitle : 'Conversation')
        .replace(/\s*\(fork #\d+\)$/i, '')
        .trim();
    let maxForkNum = 0;
    try {
        const existing = listSessions();
        const escaped = cleanBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const forkRe = new RegExp(`^${escaped}\\s*\\(fork #(\\d+)\\)$`, 'i');
        for (const s of existing) {
            const m = forkRe.exec((s.title || '').trim());
            if (m?.[1]) {
                const n = Number(m[1]);
                if (Number.isFinite(n) && n > maxForkNum)
                    maxForkNum = n;
            }
        }
    }
    catch {
        // Ignore session listing failures
    }
    return `${cleanBase} (fork #${maxForkNum + 1})`;
}
function syncInFlightMessagesToSession(loop, sourceId) {
    if (!sourceId)
        return null;
    let source = getSession(sourceId);
    const inMemory = Array.isArray(loop.messages)
        ? loop.messages.filter(m => m && m.role !== 'system')
        : [];
    const onDiskCount = source?.messages?.length ?? 0;
    if (inMemory.length > onDiskCount) {
        try {
            if (typeof loop.memoryManager?.saveHistory === 'function') {
                loop.memoryManager.saveHistory(loop.messages);
            }
            else {
                saveSessionMessages(sourceId, inMemory);
            }
            source = getSession(sourceId);
        }
        catch {
            // Keep existing source record if disk sync fails
        }
    }
    return source;
}
export function openMessageActions(host, loop, marker, anchorY = null) {
    const text = marker.meta?.messageText;
    if (typeof text !== 'string')
        return;
    const sourceId = loop.memoryManager?.sessionId || getActiveSessionId();
    const source = syncInFlightMessagesToSession(loop, sourceId);
    const markers = host.surface?.transcript.flatten(host.surface.viewport.width).markers || [];
    const index = source ? persistedMessageIndex(marker, markers, source.messages) : null;
    const canModifySession = Boolean(source && index !== null);
    const options = [
        { label: 'Copy message', description: 'to clipboard', value: 'copy' },
        ...(canModifySession
            ? [
                { label: 'Fork from here', description: 'create a new session · fresh permissions', value: 'fork' },
                { label: 'Revert to here', description: 'undo messages and file changes', value: 'revert' }
            ]
            : [])
    ];
    const layer = new MessageActionsLayer(options, (choice) => {
        if (host.surface) {
            host.surface.hoveredMessageFrameId = null;
        }
        if (!choice) {
            host.scheduleDraw();
            return;
        }
        if (choice.value === 'copy') {
            const ok = writeClipboardSync(text);
            setTransientNotice(host, ok ? 'Message copied to clipboard' : 'Clipboard unavailable on this terminal');
            return;
        }
        if (choice.value === 'fork' && source && index !== null) {
            if (host.busy) {
                host.interrupt?.();
                loop.abort?.();
                syncInFlightMessagesToSession(loop, source.id);
            }
            const forkTitle = computeNextForkTitle(source.title);
            const forked = loop.memoryManager?.sessionId === source.id && loop.memoryManager.forkSession
                ? loop.memoryManager.forkSession(forkTitle, index)
                : null;
            if (!forked) {
                setTransientNotice(host, 'Could not fork this message; session was not changed');
            }
            else {
                revokeAllAlways();
                loop.resetApprovalScope?.();
                const history = loop.memoryManager?.loadHistory?.() || forked.messages.filter(m => m.role !== 'system');
                loop.messages = history;
                loop.taskId = `cli_chat_${Date.now()}`;
                loop.tokenTracker?.reset?.();
                const info = { id: forked.id, title: forked.title, messagesCount: history.length };
                host.renderer?.setSessionInfo?.(info);
                host.renderer?.renderSessionHistory?.(history, info);
                host.surface?.viewport?.toBottom?.();
                setTransientNotice(host, `Forked into "${forked.title}". Permissions reset.`);
            }
            return;
        }
        if (choice.value === 'revert' && source && index !== null) {
            if (host.busy) {
                host.interrupt?.();
                loop.abort?.();
            }
            try {
                undoLast({ dryRun: false, scope: 'code' });
            }
            catch {
                // Checkpoints are optional if no files were modified in the reverted turn.
            }
            const latestSource = getSession(source.id) || source;
            const keptMessages = latestSource.messages.slice(0, index);
            saveSessionMessages(source.id, keptMessages);
            if (loop.memoryManager?.session && loop.memoryManager.session.id === source.id) {
                loop.memoryManager.session.messages = keptMessages;
            }
            const history = keptMessages.filter(m => m.role !== 'system');
            loop.messages = history;
            loop.taskId = `cli_chat_${Date.now()}`;
            const info = { id: latestSource.id, title: latestSource.title, messagesCount: history.length };
            host.renderer?.setSessionInfo?.(info);
            host.renderer?.renderSessionHistory?.(history, info);
            host.surface?.viewport?.toBottom?.();
            if (marker.kind === 'user' && text) {
                host.setText?.(text);
            }
            setTransientNotice(host, 'Reverted messages and file changes to selected point.');
            return;
        }
        host.scheduleDraw();
    }, anchorY);
    host.openLayer(layer);
}
/** Mouse selection for the small message menu; other dialogs retain their own input handling. */
export function handleMessageActionMenuMouse(layer, event) {
    if (!layer.messageActions || !layer.actionLayout || !event.mouse)
        return null;
    const { x, y, width, count } = layer.actionLayout;
    const { mouse } = event;
    const index = mouse.y - (y + 1); // only the frame precedes the action rows
    if (mouse.x < x || mouse.x >= x + width || index < 0 || index >= count) {
        return mouse.button === 0 && mouse.pressed ? 'close' : 'handled';
    }
    layer.list?.moveTo(index);
    if (isMouseMotion(event.sequence))
        return 'handled';
    return mouse.button === 0 && mouse.pressed ? layer.key({ name: 'enter' }) : 'handled';
}
