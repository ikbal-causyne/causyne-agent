import {
  getActiveSessionId,
  getSession,
  listSessions,
  saveSessionMessages,
  type SessionRecord
} from '../sessionJournal.js';
import { revokeAllAlways } from '../approvalGrants.js';
// @ts-expect-error Legacy checkpoints module has no TypeScript declarations yet.
import { undoLast } from '../checkpoints.js';
import { writeClipboardSync } from './clipboardSync.js';
import { registerStageConsoleGuard, setTransientNotice } from './consoleGuard.js';
import { detectLinkAtPoint, openDetectedLink } from './smartLinkClick.js';
import { sidebarVisible, sessionMainWidth } from './sessionSidebar.js';
import { stripAnsi, truncate, padEnd, visibleWidth } from './text.js';
import { Layer } from './overlay.js';
import { type MessageBounds } from './messageActionPlacement.js';
// @ts-expect-error Legacy theme has no declaration yet.
import { paint, bold, dim, fill } from './theme.js';

export interface MessageMarker {
  id: number;
  kind: string;
  row: number;
  meta?: { messageText?: string; reasoning?: boolean; collapsed?: boolean; userInteracted?: boolean } | null;
}

interface MousePoint { x: number; y: number }
interface MessageSurface {
  width: number;
  out: { rows?: number };
  stage: { height: number; reserved: boolean };
  viewport: { height: number; width: number; scrollTop: number; toBottom?: () => void };
  transcript: { flatten(width: number): { rows: string[]; markers: MessageMarker[] } };
  hoveredMessageFrameId?: number | null;
  turnRailLayout?: { turns?: unknown[] } | null;
}

interface MessageHost {
  surface: MessageSurface | null;
  busy: boolean;
  notice: string;
  renderer?: {
    renderSessionHistory?: (messages: unknown[], info: object) => void;
    setSessionInfo?: (info: object) => void;
  };
  interrupt?: () => void;
  setText?: (value: string) => void;
  openLayer(layer: unknown): unknown;
  scheduleDraw(): void;
}

export interface MessageAction {
  label: string;
  description: string;
  value: 'copy' | 'fork' | 'revert' | string;
}

/** Multi-action message menu overlay supporting Copy, Fork, and Revert. */
export class MessageActionsLayer extends Layer {
  readonly messageActions = true;
  actionLayout: { x: number; y: number; width: number; count: number } | null = null;
  anchorY: number | null;
  messageBounds: MessageBounds | null = null;
  override readonly borderRole = 'muted';
  override readonly surfaceRole = 'surfaceHi';
  readonly items: MessageAction[];
  readonly list: { filtered: MessageAction[]; selected: number; moveTo: (index: number, rows?: number) => void };
  private readonly onPick: (choice: MessageAction | null) => void;
  private settled = false;

  constructor(items: MessageAction[], onPick: (choice: MessageAction | null) => void, anchorY: number | null = null) {
    super({ title: 'Message Actions', width: 64, height: items.length + 2, footer: '↑↓ move  ·  enter select  ·  esc close' });
    this.items = items;
    this.onPick = onPick;
    this.anchorY = anchorY;
    this.list = {
      filtered: items,
      selected: 0,
      moveTo: (index: number) => { this.list.selected = Math.max(0, Math.min(items.length - 1, index)); }
    };
  }

  override preferredHeight(): number { return this.items.length + 2; }

  preferredWidth(maxWidth: number): number {
    const maxItemContent = this.items.reduce((max, item) => {
      const labelW = visibleWidth(`▸ ${item.label}`);
      const descW = item.description ? visibleWidth(item.description) + 4 : 0;
      return Math.max(max, labelW + descW);
    }, 0);
    const wanted = Math.max(48, maxItemContent + 6);
    return Math.max(36, Math.min(maxWidth, wanted));
  }

  override body(width: number): string[] {
    const labelWidth = this.items.reduce(
      (max, item) => Math.max(max, visibleWidth(`▸ ${item.label}`)),
      0
    );
    return this.items.map((item, index) => {
      const selected = index === this.list.selected;
      const rawLabel = `${selected ? '▸' : ' '} ${item.label}`;
      const pad = ' '.repeat(Math.max(0, labelWidth - visibleWidth(rawLabel)));
      const styledLabel = selected
        ? `${paint('accent', bold(rawLabel))}${pad}`
        : `${paint('ink', rawLabel)}${pad}`;
      const descBudget = Math.max(0, width - labelWidth - 2);
      const description = item.description && descBudget > 3
        ? `  ${dim(truncate(item.description, descBudget, '…'))}`
        : '';
      return truncate(`${styledLabel}${description}`, width, '…');
    });
  }

  override key(event: { name: string; ctrl?: boolean; alt?: boolean }): string {
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

  answer(): void {
    if (!this.settled) { this.settled = true; this.onPick(null); }
  }
}

interface MessageLoop {
  memoryManager?: {
    sessionId?: string | null;
    session?: SessionRecord;
    forkSession?: (title?: string | null, upToMessageIndex?: number | null) => SessionRecord | null;
    loadHistory?: () => Array<{ role: string; content?: unknown }>;
    saveHistory?: (messages: Array<{ role: string; content?: unknown }>) => void;
  };
  messages?: Array<{ role: string; content?: unknown }>;
  taskId?: string;
  abort?: () => void;
  resetApprovalScope?: () => void;
  tokenTracker?: { reset?: () => void };
}

export function isMouseMotion(sequence: string | undefined): boolean {
  const code = Number(/^\x1b\[<(\d+);/.exec(sequence || '')?.[1]);
  return Number.isFinite(code) && (code & 32) !== 0;
}

export function handleMessageMouse(
  host: MessageHost, loop: MessageLoop, event: {
    mouse?: MousePoint & { button?: number; pressed?: boolean };
    sequence?: string;
    ctrl?: boolean;
    alt?: boolean;
    shift?: boolean;
  }
): boolean {
  const mouse = event.mouse;
  const surface = host.surface;
  if (!mouse || !surface) return false;
  const marker = messageAt(surface, mouse);
  if (surface.hoveredMessageFrameId !== (marker?.id ?? null)) {
    surface.hoveredMessageFrameId = marker?.id ?? null;
    host.scheduleDraw();
  }
  // SGR motion carries bit 32; it must update hover without opening the menu.
  if (isMouseMotion(event.sequence)) return true;

  if (mouse.button === 0 && mouse.pressed) {
    const rawMarker = markerAt(surface, mouse);
    if (rawMarker && rawMarker.kind === 'reasoning') {
      const transcript = surface.transcript as unknown as {
        frames?: Array<{
          id: number;
          meta?: { reasoning?: boolean; collapsed?: boolean; userInteracted?: boolean } | null;
          rows?: unknown;
          renderedWidth?: number;
        }>;
        cache?: unknown;
        revision?: number;
        changed?: () => void;
      };
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

const isMessage = (marker: MessageMarker): boolean =>
  (marker.kind === 'user' || marker.kind === 'assistant')
  && typeof marker.meta?.messageText === 'string';

/** Resolve screen coordinates against the painted viewport to find any frame marker. */
export function markerAt(surface: MessageSurface | null, point: MousePoint): MessageMarker | null {
  if (!surface || surface.stage?.reserved === false || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  const surfWidth = surface.width || (surface.viewport as any)?.viewWidth || surface.viewport?.width || 80;
  const mainWidth = sidebarVisible(surfWidth) ? sessionMainWidth(surfWidth) : surfWidth;
  const leftGutter = (surface.turnRailLayout?.turns?.length ?? 0) > 0 ? 3 : 0;
  const viewWidth = (surface.viewport as any)?.viewWidth || surface.viewport?.width || surfWidth;
  if (point.x < leftGutter || point.x >= Math.min(mainWidth, viewWidth + leftGutter)) return null;
  const stageHeight = surface.stage?.height ?? 24;
  const top = Math.max(0, ((surface.out?.rows as number) || stageHeight) - stageHeight);
  const viewRow = point.y - top;
  const viewHeight = (surface.viewport as any)?.viewHeight || surface.viewport?.height || stageHeight;
  if (viewRow < 0 || viewRow >= viewHeight) return null;
  const transcript = surface.transcript || (surface as any).renderer?.transcript;
  if (!transcript) return null;
  const flat = transcript.flatten(viewWidth);
  const visible = Math.max(0, Math.min(viewHeight, flat.rows.length - surface.viewport.scrollTop));
  const padding = viewHeight - visible;
  if (viewRow < padding) return null;
  const row = surface.viewport.scrollTop + viewRow - padding;
  for (let i = flat.markers.length - 1; i >= 0; i--) {
    const marker = flat.markers[i];
    if (!marker || marker.row > row) continue;
    const next = flat.markers[i + 1];
    if (row < (next?.row ?? flat.rows.length)) return marker;
    return null;
  }
  return null;
}

/** Resolve screen coordinates against the painted viewport, including top padding. */
export function messageAt(surface: MessageSurface | null, point: MousePoint): MessageMarker | null {
  const marker = markerAt(surface, point);
  return marker && isMessage(marker) ? marker : null;
}

/** Highlight only the visible non-empty rows of the hovered message, without altering transcript data. */
export function markHoveredMessage(
  rows: string[], surface: MessageSurface, contentWidth: number
): void {
  registerStageConsoleGuard(surface);
  const id = surface.hoveredMessageFrameId;
  if (!id) return;
  const flat = surface.transcript.flatten(contentWidth);
  const marker = flat.markers.find(item => item.id === id);
  if (!marker || !isMessage(marker)) return;
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
  if (firstContentRow >= rawEnd) return;

  const first = Math.max(firstContentRow, surface.viewport.scrollTop);
  const last = Math.min(lastContentRow + 1, surface.viewport.scrollTop + visible);
  for (let transcriptRow = first; transcriptRow < last; transcriptRow++) {
    const row = transcriptRow - surface.viewport.scrollTop + padding;
    if (row < padding || row >= rows.length) continue;
    const existingRow = rows[row] ?? '';
    const plainTrimmed = stripAnsi(existingRow).trimStart();
    const alreadyHasMarker = /^[▸│┃|▌┌└├╭╰▪●•]/.test(plainTrimmed);
    const content = transcriptRow === firstContentRow && !alreadyHasMarker
      ? `${paint('accent', '▸')} ${truncate(existingRow, Math.max(0, contentWidth - 2), '')}`
      : existingRow;
    rows[row] = fill('surfaceHi', padEnd(content, contentWidth));
  }
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(part =>
    typeof part === 'string' ? part : part && typeof part === 'object' && 'text' in part
      ? String(part.text) : '').filter(Boolean).join('\n');
  return '';
}

function messagesMatch(persistedContent: unknown, shownText: string | undefined): boolean {
  if (typeof shownText !== 'string') return false;
  const persisted = messageText(persistedContent);
  if (persisted === shownText) return true;
  const cleanPersisted = persisted.trim();
  const cleanShown = shownText.trim();
  if (!cleanShown) return false;
  if (cleanPersisted === cleanShown) return true;
  // Handle messages where an attachment system notification was appended on save
  if (cleanPersisted.startsWith(cleanShown)) return true;
  return false;
}

/** Match in conversation order; never guess a fork point from visual row alone. */
export function persistedMessageIndex(
  marker: MessageMarker, markers: MessageMarker[], messages: SessionRecord['messages']
): number | null {
  let matched = -1;
  for (const shown of markers) {
    if (!isMessage(shown)) continue;
    let found = -1;
    for (let i = matched + 1; i < messages.length; i++) {
      const message = messages[i];
      if (message?.role === shown.kind && messagesMatch(message.content, shown.meta?.messageText)) {
        found = i;
        break;
      }
    }
    if (found >= 0) matched = found;
    if (shown.id === marker.id) return found >= 0 ? found : null;
  }
  return null;
}

function computeNextForkTitle(sourceTitle: string | undefined): string {
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
        if (Number.isFinite(n) && n > maxForkNum) maxForkNum = n;
      }
    }
  } catch {
    // Ignore session listing failures
  }
  return `${cleanBase} (fork #${maxForkNum + 1})`;
}

function syncInFlightMessagesToSession(loop: MessageLoop, sourceId: string | null): SessionRecord | null {
  if (!sourceId) return null;
  let source = getSession(sourceId);
  const inMemory = Array.isArray(loop.messages)
    ? loop.messages.filter(m => m && m.role !== 'system')
    : [];
  const onDiskCount = source?.messages?.length ?? 0;

  if (inMemory.length > onDiskCount) {
    try {
      if (typeof loop.memoryManager?.saveHistory === 'function') {
        loop.memoryManager.saveHistory(loop.messages!);
      } else {
        saveSessionMessages(sourceId, inMemory as SessionRecord['messages']);
      }
      source = getSession(sourceId);
    } catch {
      // Keep existing source record if disk sync fails
    }
  }
  return source;
}

export function openMessageActions(host: MessageHost, loop: MessageLoop, marker: MessageMarker, anchorY: number | null = null): void {
  const text = marker.meta?.messageText;
  if (typeof text !== 'string') return;
  const sourceId = loop.memoryManager?.sessionId || getActiveSessionId();
  const source = syncInFlightMessagesToSession(loop, sourceId);
  const markers = host.surface?.transcript.flatten(host.surface.viewport.width).markers || [];
  const index = source ? persistedMessageIndex(marker, markers, source.messages) : null;

  const canModifySession = Boolean(source && index !== null);
  const options: MessageAction[] = [
    { label: 'Copy message', description: 'to clipboard', value: 'copy' },
    ...(canModifySession
      ? [
          { label: 'Fork from here', description: 'create a new session · fresh permissions', value: 'fork' } as const,
          { label: 'Revert to here', description: 'undo messages and file changes', value: 'revert' } as const
        ]
      : [])
  ];

  let messageBounds: MessageBounds | null = null;
  if (host.surface?.viewport && host.surface?.transcript) {
    const flat = host.surface.transcript.flatten(host.surface.viewport.width);
    const mIdx = flat.markers.findIndex(m => m.id === marker.id);
    if (mIdx >= 0) {
      const nextM = flat.markers[mIdx + 1];
      const rawStart = marker.row;
      const rawEnd = nextM ? nextM.row - 1 : flat.rows.length - 1;
      const visible = Math.max(0, Math.min(host.surface.viewport.height, flat.rows.length - host.surface.viewport.scrollTop));
      const padding = host.surface.viewport.height - visible;
      const startRow = rawStart - host.surface.viewport.scrollTop + padding;
      const endRow = rawEnd - host.surface.viewport.scrollTop + padding;
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
      } else {
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
      } catch {
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
  layer.messageBounds = messageBounds;
  host.openLayer(layer);
}

/** Mouse selection for the small message menu; other dialogs retain their own input handling. */
export function handleMessageActionMenuMouse(
  layer: { messageActions?: boolean; actionLayout?: { x: number; y: number; width: number; count: number };
    list?: { moveTo(index: number): unknown }; key(event: { name: string }): string | null },
  event: { mouse?: MousePoint & { button?: number; pressed?: boolean }; sequence?: string }
): string | null {
  if (!layer.messageActions || !layer.actionLayout || !event.mouse) return null;
  const { x, y, width, count } = layer.actionLayout;
  const { mouse } = event;
  const index = mouse.y - (y + 1); // only the frame precedes the action rows
  if (mouse.x < x || mouse.x >= x + width || index < 0 || index >= count) {
    return mouse.button === 0 && mouse.pressed ? 'close' : 'handled';
  }
  layer.list?.moveTo(index);
  if (isMouseMotion(event.sequence)) return 'handled';
  return mouse.button === 0 && mouse.pressed ? layer.key({ name: 'enter' }) : 'handled';
}
