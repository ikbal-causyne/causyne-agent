import { getActiveSessionId, getSession, listSessions, saveSessionMessages } from '../sessionJournal.js';
import { revokeAllAlways } from '../approvalGrants.js';
// @ts-expect-error Legacy checkpoints module has no TypeScript declarations yet.
import { undoLast } from '../checkpoints.js';
import { writeClipboardSync } from './clipboardSync.js';
import { registerStageConsoleGuard, setTransientNotice } from './consoleGuard.js';
import { detectLinkAtPoint, openDetectedLink } from './smartLinkClick.js';
import { sidebarVisible, sessionMainWidth } from './sessionSidebar.js';
import { safeDisplay, stripAnsi, truncate, padEnd, visibleWidth } from './text.js';
import { Layer } from './overlay.js';
import {} from './messageActionPlacement.js';
// @ts-expect-error Legacy theme has no declaration yet.
import { paint, bold, dim, fill } from './theme.js';
/** Multi-action message menu overlay supporting Copy, Fork, and Revert. */
export class MessageActionsLayer extends Layer {
    messageActions = true;
    actionLayout = null;
    anchorY;
    messageBounds = null;
    borderRole = 'muted';
    surfaceRole = 'surfaceHi';
    items;
    list;
    onPick;
    settled = false;
    constructor(items, onPick, anchorY = null) {
        super({ title: 'Message Actions', width: 64, height: items.length + 2, footer: '↑↓ move  ·  enter select  ·  esc close' });
        this.items = items;
        this.onPick = onPick;
        this.anchorY = anchorY;
        this.list = {
            filtered: items,
            selected: 0,
            moveTo: (index) => {
                if (!Number.isFinite(index) || items.length === 0)
                    return;
                this.list.selected = Math.max(0, Math.min(items.length - 1, Math.floor(index)));
            }
        };
    }
    cleanText(value) {
        return safeDisplay(typeof value === 'string' ? value : String(value ?? ''))
            .replace(/[\r\n]+/g, ' ')
            .trim();
    }
    preferredHeight() { return this.items.length + 2; }
    preferredWidth(maxWidth) {
        const safeMax = Number.isFinite(maxWidth)
            ? Math.floor(maxWidth)
            : maxWidth === Number.POSITIVE_INFINITY
                ? Number.POSITIVE_INFINITY
                : 64;
        const maxItemContent = this.items.reduce((max, item) => {
            const labelW = visibleWidth(`▸ ${this.cleanText(item.label)}`);
            const cleanDesc = item.description ? this.cleanText(item.description) : '';
            const descW = cleanDesc ? visibleWidth(cleanDesc) + 4 : 0;
            return Math.max(max, labelW + descW);
        }, 0);
        const wanted = Math.max(48, maxItemContent + 6);
        return Math.max(36, Math.min(safeMax, wanted));
    }
    body(width) {
        const safeWidth = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 60;
        const cleanItems = this.items.map((item) => ({
            label: this.cleanText(item.label),
            description: item.description ? this.cleanText(item.description) : ''
        }));
        const labelWidth = cleanItems.reduce((max, item) => Math.max(max, visibleWidth(`▸ ${item.label}`)), 0);
        return cleanItems.map((item, index) => {
            const selected = index === this.list.selected;
            const rawLabel = `${selected ? '▸' : ' '} ${item.label}`;
            const pad = ' '.repeat(Math.max(0, labelWidth - visibleWidth(rawLabel)));
            const styledLabel = selected
                ? `${paint('accent', bold(rawLabel))}${pad}`
                : `${paint('ink', rawLabel)}${pad}`;
            const descBudget = Math.max(0, safeWidth - labelWidth - 2);
            const description = item.description && descBudget > 3
                ? `  ${dim(truncate(item.description, descBudget, '…'))}`
                : '';
            return truncate(`${styledLabel}${description}`, safeWidth, '…');
        });
    }
    key(event) {
        if (!event || typeof event !== 'object')
            return 'handled';
        const keyName = typeof event.name === 'string' ? event.name : '';
        if (keyName === 'escape') {
            this.settled = true;
            this.onPick(null);
            return 'close';
        }
        if (keyName === 'up' || keyName === 'down') {
            if (this.items.length > 0) {
                const delta = keyName === 'up' ? -1 : 1;
                this.list.moveTo((this.list.selected + delta + this.items.length) % this.items.length);
            }
            return 'handled';
        }
        if (keyName === 'enter' || keyName === 'return') {
            this.settled = true;
            this.onPick(this.items[this.list.selected] ?? null);
            return 'close';
        }
        if (!event.ctrl && !event.alt && keyName && (keyName.length === 1 || keyName === 'space' || keyName === 'backspace')) {
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
        const rawMarker = markerAt(surface, mouse);
        if (rawMarker && rawMarker.kind === 'reasoning') {
            const transcript = surface.transcript;
            const frames = transcript?.frames;
            const frame = Array.isArray(frames) ? frames.find(f => f.id === rawMarker.id) : null;
            if (frame && frame.meta && frame.meta.reasoning) {
                frame.meta.collapsed = !frame.meta.collapsed;
                frame.meta.userInteracted = true;
                frame.rows = null;
                frame.renderedWidth = -1;
                if (transcript) {
                    transcript.cache = null;
                    transcript.revision = (transcript.revision || 0) + 1;
                    transcript.changed?.();
                }
                host.scheduleDraw();
                return true;
            }
        }
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
const positiveDim = (value, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};
/** Resolve screen coordinates against the painted viewport to find any frame marker. */
export function markerAt(surface, point) {
    if (!surface || surface.stage?.reserved === false || !Number.isFinite(point.x) || !Number.isFinite(point.y))
        return null;
    const px = Math.floor(point.x);
    const py = Math.floor(point.y);
    const rawViewW = surface.viewport?.viewWidth;
    const surfWidth = positiveDim(surface.width, positiveDim(rawViewW, positiveDim(surface.viewport?.width, 80)));
    const mainWidth = sidebarVisible(surfWidth, false, surface.env)
        ? sessionMainWidth(surfWidth, false, surface.env)
        : surfWidth;
    const leftGutter = (surface.turnRailLayout?.turns?.length ?? 0) > 0 ? 3 : 0;
    const viewWidth = positiveDim(rawViewW, positiveDim(surface.viewport?.width, surfWidth));
    if (px < leftGutter || px >= Math.min(mainWidth, viewWidth + leftGutter))
        return null;
    const stageHeight = surface.stage?.height === 0 ? 0 : positiveDim(surface.stage?.height, 24);
    const outRows = positiveDim(surface.out?.rows, stageHeight);
    const top = Math.max(0, outRows - stageHeight);
    const viewRow = py - top;
    const viewHeight = positiveDim(surface.viewport?.viewHeight, positiveDim(surface.viewport?.height, stageHeight));
    if (viewRow < 0 || viewRow >= viewHeight)
        return null;
    const transcript = surface.transcript || surface.renderer?.transcript;
    if (!transcript)
        return null;
    const flat = transcript.flatten(viewWidth);
    const scrollTop = Number.isFinite(surface.viewport?.scrollTop) ? Math.max(0, Math.floor(surface.viewport.scrollTop)) : 0;
    const visible = Math.max(0, Math.min(viewHeight, flat.rows.length - scrollTop));
    const padding = viewHeight - visible;
    if (viewRow < padding)
        return null;
    const row = scrollTop + viewRow - padding;
    for (let i = flat.markers.length - 1; i >= 0; i--) {
        const marker = flat.markers[i];
        if (!marker || marker.row > row)
            continue;
        const next = flat.markers[i + 1];
        if (row < (next?.row ?? flat.rows.length))
            return marker;
        return null;
    }
    return null;
}
/** Resolve screen coordinates against the painted viewport, including top padding. */
export function messageAt(surface, point) {
    const marker = markerAt(surface, point);
    return marker && isMessage(marker) ? marker : null;
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
    const scrollTop = Number.isFinite(surface.viewport?.scrollTop) ? Math.max(0, Math.floor(surface.viewport.scrollTop)) : 0;
    const visible = Math.max(0, Math.min(rows.length, flat.rows.length - scrollTop));
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
    const first = Math.max(firstContentRow, scrollTop);
    const last = Math.min(lastContentRow + 1, scrollTop + visible);
    for (let transcriptRow = first; transcriptRow < last; transcriptRow++) {
        const row = transcriptRow - scrollTop + padding;
        if (row < padding || row >= rows.length)
            continue;
        const existingRow = rows[row] ?? '';
        let content = existingRow;
        if (transcriptRow === firstContentRow) {
            const plainTrimmed = stripAnsi(existingRow).trimStart();
            const alreadyHasMarker = /^[▸│┃|▌┌└├╭╰▪●•]/.test(plainTrimmed);
            if (!alreadyHasMarker) {
                if (existingRow.startsWith('   ')) {
                    content = ` ${paint('accent', '▸')} ${existingRow.slice(3)}`;
                }
                else if (existingRow.startsWith('  ')) {
                    content = ` ${paint('accent', '▸')}${existingRow.slice(2)}`;
                }
                else if (existingRow.startsWith(' ')) {
                    content = `${paint('accent', '▸')}${existingRow.slice(1)}`;
                }
            }
        }
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
    let messageBounds = null;
    if (host.surface?.viewport && host.surface?.transcript) {
        const flat = host.surface.transcript.flatten(host.surface.viewport.width);
        const mIdx = flat.markers.findIndex(m => m.id === marker.id);
        if (mIdx >= 0) {
            const nextM = flat.markers[mIdx + 1];
            const rawStart = marker.row;
            const rawEnd = nextM ? nextM.row - 1 : flat.rows.length - 1;
            const scrollTop = Number.isFinite(host.surface.viewport.scrollTop)
                ? Math.max(0, Math.floor(host.surface.viewport.scrollTop))
                : 0;
            const visible = Math.max(0, Math.min(host.surface.viewport.height, flat.rows.length - scrollTop));
            const padding = host.surface.viewport.height - visible;
            const startRow = rawStart - scrollTop + padding;
            const endRow = rawEnd - scrollTop + padding;
            messageBounds = { startRow, endRow, textLength: text.length };
        }
    }
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
                host.surface?.setSessionInfo?.(info);
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
            host.surface?.setSessionInfo?.(info);
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
    layer.messageBounds = messageBounds;
    host.openLayer(layer);
}
/** Mouse selection for the small message menu; other dialogs retain their own input handling. */
export function handleMessageActionMenuMouse(layer, event) {
    if (!layer.messageActions || !layer.actionLayout || !event.mouse)
        return null;
    const { x, y, width, count } = layer.actionLayout;
    const { mouse } = event;
    if (!Number.isFinite(mouse.x) || !Number.isFinite(mouse.y)
        || !Number.isFinite(x) || !Number.isFinite(y)
        || !Number.isFinite(width) || !Number.isFinite(count)) {
        return 'handled';
    }
    const mouseX = Math.floor(mouse.x);
    const mouseY = Math.floor(mouse.y);
    const index = mouseY - (Math.floor(y) + 1); // only the frame precedes the action rows
    if (mouseX < x || mouseX >= x + width || index < 0 || index >= count) {
        return mouse.button === 0 && mouse.pressed ? 'close' : 'handled';
    }
    layer.list?.moveTo(index);
    if (isMouseMotion(event.sequence))
        return 'handled';
    return mouse.button === 0 && mouse.pressed ? layer.key({ name: 'enter' }) : 'handled';
}
