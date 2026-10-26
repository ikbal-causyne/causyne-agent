import { getActiveSessionId, getSession } from '../sessionJournal.js';
import { revokeAllAlways } from '../approvalGrants.js';
import { writeClipboardSync } from './clipboardSync.js';
import { sidebarVisible, sessionMainWidth } from './sessionSidebar.js';
import { truncate, padEnd } from './text.js';
// @ts-expect-error Legacy overlay has no declaration yet.
import { Layer } from './overlay.js';
// @ts-expect-error Legacy theme has no declaration yet.
import { paint, bold, fill } from './theme.js';
/** Two actions need two rows; the generic searchable picker hides the second one. */
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
        if (event.name === 'escape')
            return 'close';
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
    if (mouse.button === 0 && mouse.pressed && marker)
        openMessageActions(host, loop, marker, mouse.y);
    return true;
}
const isMessage = (marker) => (marker.kind === 'user' || marker.kind === 'assistant')
    && typeof marker.meta?.messageText === 'string';
/** Resolve screen coordinates against the painted viewport, including top padding. */
export function messageAt(surface, point) {
    if (!surface?.stage.reserved || !Number.isFinite(point.x) || !Number.isFinite(point.y))
        return null;
    const mainWidth = sidebarVisible(surface.width) ? sessionMainWidth(surface.width) : surface.width;
    if (point.x < 0 || point.x >= Math.min(mainWidth, surface.viewport.width))
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
/** Highlight only the visible rows of the hovered message, without altering transcript data. */
export function markHoveredMessage(rows, surface, contentWidth) {
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
    const first = Math.max(marker.row, surface.viewport.scrollTop);
    const last = Math.min(next?.row ?? flat.rows.length, surface.viewport.scrollTop + visible);
    for (let transcriptRow = first; transcriptRow < last; transcriptRow++) {
        const row = transcriptRow - surface.viewport.scrollTop + padding;
        if (row < padding || row >= rows.length)
            continue;
        const content = transcriptRow === marker.row
            ? `${paint('accent', '▸')} ${truncate(rows[row] ?? '', Math.max(0, contentWidth - 2), '')}`
            : rows[row] ?? '';
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
/** Match in conversation order; never guess a fork point from visual row alone. */
export function persistedMessageIndex(marker, markers, messages) {
    let matched = -1;
    for (const shown of markers) {
        if (!isMessage(shown))
            continue;
        let found = -1;
        for (let i = matched + 1; i < messages.length; i++) {
            const message = messages[i];
            if (message?.role === shown.kind && messageText(message.content) === shown.meta?.messageText) {
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
export function openMessageActions(host, loop, marker, anchorY = null) {
    const text = marker.meta?.messageText;
    if (typeof text !== 'string')
        return;
    const sourceId = loop.memoryManager?.sessionId || getActiveSessionId();
    const source = sourceId ? getSession(sourceId) : null;
    const markers = host.surface?.transcript.flatten(host.surface.viewport.width).markers || [];
    const index = source ? persistedMessageIndex(marker, markers, source.messages) : null;
    const options = [
        { label: 'Copy message', description: 'to clipboard', value: 'copy' },
        ...(!host.busy && index !== null ? [{ label: 'Fork from here', description: 'fresh permissions', value: 'fork' }] : [])
    ];
    const layer = new MessageActionsLayer(options, (choice) => {
        if (choice?.value === 'copy') {
            host.notice = writeClipboardSync(text) ? 'Message copied to clipboard' : 'Clipboard unavailable on this terminal';
        }
        if (choice?.value === 'fork' && source && index !== null && !host.busy) {
            const forked = loop.memoryManager?.sessionId === source.id && loop.memoryManager.forkSession
                ? loop.memoryManager.forkSession(null, index)
                : null;
            if (!forked) {
                host.notice = 'Could not fork this message; session was not changed';
            }
            else {
                revokeAllAlways();
                loop.resetApprovalScope?.();
                const history = loop.memoryManager?.loadHistory?.() || forked.messages.filter(m => m.role !== 'system');
                loop.messages = history;
                loop.taskId = `cli_chat_${Date.now()}`;
                loop.tokenTracker?.reset?.();
                host.renderer?.renderSessionHistory?.(history, {
                    id: forked.id, title: forked.title, messagesCount: history.length
                });
                host.surface?.viewport?.toBottom?.();
                host.notice = 'Forked from selected message. Permissions reset.';
            }
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
    const index = mouse.y - (y + 1); // only the frame precedes the two action rows
    if (mouse.x < x || mouse.x >= x + width || index < 0 || index >= count)
        return 'handled';
    layer.list?.moveTo(index);
    if (isMouseMotion(event.sequence))
        return 'handled';
    return mouse.button === 0 && mouse.pressed ? layer.key({ name: 'enter' }) : 'handled';
}
