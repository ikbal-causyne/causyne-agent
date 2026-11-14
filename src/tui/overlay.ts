// Modal layer: the thing that makes this an application rather than a log.
//
// opencode keeps a dialog STACK and pushes a "modal" entry onto a keybinding
// mode stack while any dialog is open (ui/dialog.tsx, keymap.tsx). That detail is
// the whole design. Without a mode stack, a dialog is just a box that happens to
// be painted on top, and keys leak through to the prompt underneath — you type
// to filter the palette and your text also lands in the message box. With one,
// the top layer owns the keyboard and pops cleanly.
//
// The backdrop is dimmed rather than blacked out. opencode paints an alpha fill
// over the screen; a cell grid cannot blend, but it can add the SGR dim
// attribute to every cell behind the panel, which reads the same way and keeps
// the conversation legible underneath.
//
// Pure Node over ./screen.js, ./theme.js and ./text.js. No dependency, no shell.

// @ts-expect-error theme.js has no TypeScript declaration yet.
import { paint, bold, dim, fill, GLYPHS, HAS_COLOR, HAS_UNICODE } from './theme.js';
import { truncate, visibleWidth } from './text.js';

export interface OverlayRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface OverlayScreenCell {
  ch?: string;
  style?: string;
}

export interface OverlayScreen {
  width: number;
  height: number;
  cells: OverlayScreenCell[];
  fill(x: number, y: number, width: number, height: number, style: string): void;
  put(x: number, y: number, text: string, maxWidth: number): void;
  setCursor(x: number, y: number): void;
}

export interface LayerOptions {
  title?: string | undefined;
  footer?: string | undefined;
  width?: number | undefined;
  height?: number | undefined;
  onClose?: (() => void) | null | undefined;
  onSelect?: ((item: unknown) => void) | null | undefined;
}

export interface PanelRenderableLayer {
  title?: string | undefined;
  footer?: string | undefined;
  borderRole?: string | undefined;
  surfaceRole?: string | undefined;
  preferredHeight(): number;
  body(width: number, height: number): string[];
}

// Box-drawing set, degrading with the rest of the glyphs.
export const FRAME: { tl: string; tr: string; bl: string; br: string; h: string; v: string } = HAS_UNICODE
  ? { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' }
  : { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|' };

/**
 * Add the SGR dim attribute to every cell in a region.
 *
 * Operates on the grid AFTER the page beneath has been painted, which is why the
 * conversation stays readable behind a dialog instead of being erased.
 */
export function dimBackdrop(screen: OverlayScreen, viewport: OverlayRect, hole?: OverlayRect | null): void {
  if (!HAS_COLOR) return;
  for (let row = viewport.y; row < viewport.y + viewport.height; row++) {
    if (row < 0 || row >= screen.height) continue;
    for (let column = viewport.x; column < viewport.x + viewport.width; column++) {
      if (column < 0 || column >= screen.width) continue;
      if (hole
        && row >= hole.y && row < hole.y + hole.height
        && column >= hole.x && column < hole.x + hole.width) continue;

      const cell = screen.cells[row * screen.width + column];
      if (!cell) continue;
      if (cell.ch === ' ' && !cell.style) continue;
      const parts = cell.style ? cell.style.split(';') : [];
      if (!parts.includes('2')) parts.push('2');
      cell.style = parts.join(';');
    }
  }
}

/**
 * Draw a framed panel and return the rect available INSIDE it.
 *
 * The frame is painted onto its own blank ground first, so a dialog never shows
 * the transcript bleeding through the gaps between its rows.
 */
export function drawPanel(
  screen: OverlayScreen,
  rect: OverlayRect,
  { title = '', footer = '' }: { title?: string; footer?: string } = {}
): OverlayRect {
  const x = Number.isFinite(rect.x) ? Math.floor(rect.x) : 0;
  const y = Number.isFinite(rect.y) ? Math.floor(rect.y) : 0;
  if (!Number.isFinite(rect.x) || !Number.isFinite(rect.y) || !Number.isFinite(rect.width) || !Number.isFinite(rect.height)) {
    return { x, y, width: 0, height: 0 };
  }
  const w = Math.floor(rect.width);
  const h = Math.floor(rect.height);
  if (w < 4 || h < 3) return { x, y, width: 0, height: 0 };

  screen.fill(x, y, w, h, '');

  const inner = w - 2;
  const line = FRAME.h.repeat(inner);

  // Title sits in the top border, the way every terminal dialog has since curses.
  let top = FRAME.tl + line + FRAME.tr;
  if (title) {
    const label = ` ${truncate(title, Math.max(0, inner - 4), GLYPHS.ellipsis)} `;
    const width = visibleWidth(label);
    top = FRAME.tl + FRAME.h + label + FRAME.h.repeat(Math.max(0, inner - width - 1)) + FRAME.tr;
  }

  let bottom = FRAME.bl + line + FRAME.br;
  if (footer) {
    const label = ` ${truncate(footer, Math.max(0, inner - 4), GLYPHS.ellipsis)} `;
    const width = visibleWidth(label);
    bottom = FRAME.bl + FRAME.h.repeat(Math.max(0, inner - width - 1)) + label + FRAME.h + FRAME.br;
  }

  screen.put(x, y, paint('rule', top), w);
  screen.put(x, y + h - 1, paint('rule', bottom), w);

  for (let row = y + 1; row < y + h - 1; row++) {
    screen.put(x, row, paint('rule', FRAME.v), 1);
    screen.put(x + w - 1, row, paint('rule', FRAME.v), 1);
  }

  return {
    x: x + 2,
    y: y + 1,
    width: Math.max(0, w - 4),
    height: Math.max(0, h - 2)
  };
}

/**
 * A layer on the stack.
 *
 * Subclasses implement `body(width, height)` returning styled rows, and may
 * implement `key(event)` returning 'close' | 'handled' | null. Returning null
 * means "not mine" — but the stack still does NOT forward it downward, because a
 * modal that leaks keys is the bug this class exists to prevent. null only means
 * the layer chose to ignore it.
 */
export class Layer {
  title: string;
  footer: string;
  width: number;
  height: number;
  borderRole?: string | undefined;
  surfaceRole?: string | undefined;
  onClose: (() => void) | null;
  onSelect: ((item: unknown) => void) | null;
  cursor: { x: number; y: number } | null;

  constructor(options: LayerOptions = {}) {
    this.title = options.title || '';
    this.footer = options.footer || '';
    this.width = options.width || 64;
    this.height = options.height || 16;
    this.onClose = options.onClose || null;
    this.onSelect = options.onSelect || null;
    this.cursor = null;
  }

  /**
   * Rows this layer would like, given its content.
   *
   * A dialog padded out to a fixed height with blank rows looks unfinished —
   * it is the single clearest tell between a prototype and a shipped tool. Every
   * layer reports what it actually needs and the frame shrinks to it.
   */
  preferredHeight(): number { return this.height; }

  /** Panel rect, centred and clamped to the viewport. */
  rect(viewport: OverlayRect): OverlayRect {
    const vx = Number.isFinite(viewport.x) ? Math.floor(viewport.x) : 0;
    const vy = Number.isFinite(viewport.y) ? Math.floor(viewport.y) : 0;
    const vw = Number.isFinite(viewport.width) ? Math.floor(viewport.width) : 80;
    const vh = Number.isFinite(viewport.height) ? Math.floor(viewport.height) : 24;
    const layerWidth = Number.isFinite(this.width) ? Math.floor(this.width) : 64;
    const layerHeight = Number.isFinite(this.height) ? Math.floor(this.height) : 16;
    const rawPreferred = this.preferredHeight();
    const safePreferred = Number.isFinite(rawPreferred) ? Math.floor(rawPreferred) : layerHeight;
    const width = Math.min(layerWidth, Math.max(20, vw - 4));
    const wanted = Math.max(5, Math.min(safePreferred, layerHeight));
    const height = Math.min(wanted, Math.max(5, vh - 4));
    return {
      x: vx + Math.floor((vw - width) / 2),
      // A quarter down reads as centred; dead centre sits visually too low.
      y: vy + Math.max(1, Math.floor((vh - height) / 4)),
      width,
      height
    };
  }

  body(_width?: number, _height?: number): string[] { return []; }
  key(_event?: any): string | null { return null; }
}

export class OverlayStack {
  layers: Layer[];

  constructor() {
    this.layers = [];
  }

  get top(): Layer | null { return this.layers.length > 0 ? (this.layers[this.layers.length - 1] ?? null) : null; }
  get active(): boolean { return this.layers.length > 0; }
  get depth(): number { return this.layers.length; }

  push<T extends Layer>(layer: T): T {
    this.layers.push(layer);
    return layer;
  }

  /** Pop exactly one layer. Nested dialogs unwind one esc at a time. */
  pop(): Layer | null {
    const layer = this.layers.pop();
    if (layer && layer.onClose) layer.onClose();
    return layer || null;
  }

  clear(): void {
    while (this.layers.length > 0) this.pop();
  }

  /**
   * Route a key.
   *
   * Returns true when a modal consumed it — which is ALWAYS, while one is open.
   * The caller uses that to decide whether the prompt beneath ever sees the key,
   * and the answer while a dialog is up must be no.
   */
  handleKey(key: unknown): boolean {
    const layer = this.top;
    if (!layer) return false;

    const result = layer.key(key);
    if (result === 'close') this.pop();
    return true;
  }

  /** Paint every layer bottom to top, dimming what is behind the topmost. */
  paint(screen: OverlayScreen, viewport: OverlayRect): void {
    for (let index = 0; index < this.layers.length; index++) {
      const layer = this.layers[index];
      if (!layer) continue;
      const rect = layer.rect(viewport);

      dimBackdrop(screen, viewport, rect);
      const inner = drawPanel(screen, rect, { title: layer.title, footer: layer.footer });
      if (inner.height <= 0) continue;

      const rows = layer.body(inner.width, inner.height) || [];
      for (let row = 0; row < Math.min(rows.length, inner.height); row++) {
        screen.put(inner.x, inner.y + row, rows[row] ?? '', inner.width);
      }

      // Only the topmost layer may own the caret.
      if (index === this.layers.length - 1 && layer.cursor) {
        screen.setCursor(inner.x + layer.cursor.x, inner.y + layer.cursor.y);
      }
    }
  }
}

/**
 * A layer as framed rows, for a normal-buffer live region.
 *
 * drawPanel() paints absolutely into a cell grid, which only exists inside an
 * alternate-buffer app — and chat does not have one any more (UX-01). This is the
 * same panel expressed as styled `string[]`, which is all a live region can
 * append. It is the shape openclaw draws its pickers in: extra lines in the
 * composed frame, not a floating window.
 *
 * Every row is wrapped with `fill('surface', ...)` so that when a panel (such as
 * Message Actions) is overlaid onto the transcript viewport, its interior has an
 * opaque surface background and legible header/footer typography.
 */
export function panelRows(layer: PanelRenderableLayer, width: number, maxHeight: number): string[] {
  const safeWidth = Number.isFinite(width) ? Math.floor(width) : 8;
  const rawPreferred = layer.preferredHeight();
  const preferred = Number.isFinite(rawPreferred) ? Math.floor(rawPreferred) : 3;
  const safeMaxHeight = Number.isFinite(maxHeight)
    ? Math.floor(maxHeight)
    : (maxHeight === Infinity ? preferred : 3);
  const frameWidth = Math.max(8, safeWidth);
  const inner = frameWidth - 4;                    // two borders, one pad each side
  const bodyHeight = Math.max(1, Math.min(preferred, safeMaxHeight) - 2);
  const body = layer.body(inner, bodyHeight);

  const borderRole = layer.borderRole || 'rule';
  const surfaceRole = layer.surfaceRole || 'surface';
  const line = FRAME.h.repeat(frameWidth - 2);

  let top = paint(borderRole, FRAME.tl + line + FRAME.tr);
  if (layer.title) {
    const label = ` ${truncate(layer.title, Math.max(0, inner - 4), GLYPHS.ellipsis)} `;
    const trail = FRAME.h.repeat(Math.max(0, frameWidth - 3 - visibleWidth(label)));
    top = paint(borderRole, FRAME.tl + FRAME.h) + bold(paint('ink', label)) + paint(borderRole, trail + FRAME.tr);
  }

  let bottom = paint(borderRole, FRAME.bl + line + FRAME.br);
  if (layer.footer) {
    const label = ` ${truncate(layer.footer, Math.max(0, inner - 4), GLYPHS.ellipsis)} `;
    const lead = FRAME.h.repeat(Math.max(0, frameWidth - 3 - visibleWidth(label)));
    bottom = paint(borderRole, FRAME.bl + lead) + dim(label) + paint(borderRole, FRAME.h + FRAME.br);
  }

  const edge = paint(borderRole, FRAME.v);
  const rows: string[] = [fill(surfaceRole, top)];
  for (let index = 0; index < bodyHeight; index++) {
    const content = truncate(body[index] || '', inner, GLYPHS.ellipsis);
    const pad = ' '.repeat(Math.max(0, inner - visibleWidth(content)));
    rows.push(fill(surfaceRole, `${edge} ${content}${pad} ${edge}`));
  }
  rows.push(fill(surfaceRole, bottom));
  return rows;
}

/** Shared footer text so every dialog teaches the same keys. */
export function dialogHint(extra = ''): string {
  const parts = ['↑↓ move', 'enter select', 'esc close'];
  if (extra) parts.push(extra);
  return parts.join(`  ${GLYPHS.dot}  `);
}

export { bold, dim };

