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

import { paint, bold, dim, GLYPHS, HAS_COLOR, HAS_UNICODE } from './theme.js';
import { truncate, visibleWidth } from './text.js';

// Box-drawing set, degrading with the rest of the glyphs.
export const FRAME = HAS_UNICODE
  ? { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' }
  : { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|' };

/**
 * Add the SGR dim attribute to every cell in a region.
 *
 * Operates on the grid AFTER the page beneath has been painted, which is why the
 * conversation stays readable behind a dialog instead of being erased.
 */
export function dimBackdrop(screen, viewport, hole) {
  if (!HAS_COLOR) return;
  for (let row = viewport.y; row < viewport.y + viewport.height; row++) {
    if (row < 0 || row >= screen.height) continue;
    for (let column = viewport.x; column < viewport.x + viewport.width; column++) {
      if (column < 0 || column >= screen.width) continue;
      if (hole
        && row >= hole.y && row < hole.y + hole.height
        && column >= hole.x && column < hole.x + hole.width) continue;

      const cell = screen.cells[row * screen.width + column];
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
export function drawPanel(screen, rect, { title = '', footer = '' } = {}) {
  if (rect.width < 4 || rect.height < 3) return { x: rect.x, y: rect.y, width: 0, height: 0 };

  screen.fill(rect.x, rect.y, rect.width, rect.height, '');

  const inner = rect.width - 2;
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

  screen.put(rect.x, rect.y, paint('rule', top), rect.width);
  screen.put(rect.x, rect.y + rect.height - 1, paint('rule', bottom), rect.width);

  for (let row = rect.y + 1; row < rect.y + rect.height - 1; row++) {
    screen.put(rect.x, row, paint('rule', FRAME.v), 1);
    screen.put(rect.x + rect.width - 1, row, paint('rule', FRAME.v), 1);
  }

  return {
    x: rect.x + 2,
    y: rect.y + 1,
    width: Math.max(0, rect.width - 4),
    height: Math.max(0, rect.height - 2)
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
  constructor(options = {}) {
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
  preferredHeight() { return this.height; }

  /** Panel rect, centred and clamped to the viewport. */
  rect(viewport) {
    const width = Math.min(this.width, Math.max(20, viewport.width - 4));
    const wanted = Math.max(5, Math.min(this.preferredHeight(), this.height));
    const height = Math.min(wanted, Math.max(5, viewport.height - 4));
    return {
      x: viewport.x + Math.floor((viewport.width - width) / 2),
      // A quarter down reads as centred; dead centre sits visually too low.
      y: viewport.y + Math.max(1, Math.floor((viewport.height - height) / 4)),
      width,
      height
    };
  }

  body() { return []; }
  key() { return null; }
}

export class OverlayStack {
  constructor() {
    this.layers = [];
  }

  get top() { return this.layers.length > 0 ? this.layers[this.layers.length - 1] : null; }
  get active() { return this.layers.length > 0; }
  get depth() { return this.layers.length; }

  push(layer) {
    this.layers.push(layer);
    return layer;
  }

  /** Pop exactly one layer. Nested dialogs unwind one esc at a time. */
  pop() {
    const layer = this.layers.pop();
    if (layer && layer.onClose) layer.onClose();
    return layer || null;
  }

  clear() {
    while (this.layers.length > 0) this.pop();
  }

  /**
   * Route a key.
   *
   * Returns true when a modal consumed it — which is ALWAYS, while one is open.
   * The caller uses that to decide whether the prompt beneath ever sees the key,
   * and the answer while a dialog is up must be no.
   */
  handleKey(key) {
    const layer = this.top;
    if (!layer) return false;

    const result = layer.key(key);
    if (result === 'close') this.pop();
    return true;
  }

  /** Paint every layer bottom to top, dimming what is behind the topmost. */
  paint(screen, viewport) {
    for (let index = 0; index < this.layers.length; index++) {
      const layer = this.layers[index];
      const rect = layer.rect(viewport);

      dimBackdrop(screen, viewport, rect);
      const inner = drawPanel(screen, rect, { title: layer.title, footer: layer.footer });
      if (inner.height <= 0) continue;

      const rows = layer.body(inner.width, inner.height) || [];
      for (let row = 0; row < Math.min(rows.length, inner.height); row++) {
        screen.put(inner.x, inner.y + row, rows[row], inner.width);
      }

      // Only the topmost layer may own the caret.
      if (index === this.layers.length - 1 && layer.cursor) {
        screen.setCursor(inner.x + layer.cursor.x, inner.y + layer.cursor.y);
      }
    }
  }
}

/** Shared footer text so every dialog teaches the same keys. */
/**
 * A layer as framed rows, for a normal-buffer live region.
 *
 * drawPanel() paints absolutely into a cell grid, which only exists inside an
 * alternate-buffer app — and chat does not have one any more (UX-01). This is the
 * same panel expressed as styled `string[]`, which is all a live region can
 * append. It is the shape openclaw draws its pickers in: extra lines in the
 * composed frame, not a floating window.
 *
 * There is deliberately no backdrop dim: a line already committed to the user's
 * scrollback cannot be restyled, and pretending otherwise would corrupt it.
 */
export function panelRows(layer, width, maxHeight) {
  const frameWidth = Math.max(8, width);
  const inner = frameWidth - 4;                    // two borders, one pad each side
  const bodyHeight = Math.max(1, Math.min(layer.preferredHeight(), maxHeight) - 2);
  const body = layer.body(inner, bodyHeight);

  const line = FRAME.h.repeat(frameWidth - 2);

  let top = FRAME.tl + line + FRAME.tr;
  if (layer.title) {
    const label = ` ${truncate(layer.title, Math.max(0, inner - 4), GLYPHS.ellipsis)} `;
    top = FRAME.tl + FRAME.h + label + FRAME.h.repeat(Math.max(0, frameWidth - 3 - visibleWidth(label))) + FRAME.tr;
  }

  let bottom = FRAME.bl + line + FRAME.br;
  if (layer.footer) {
    const label = ` ${truncate(layer.footer, Math.max(0, inner - 4), GLYPHS.ellipsis)} `;
    bottom = FRAME.bl + FRAME.h.repeat(Math.max(0, frameWidth - 3 - visibleWidth(label))) + label + FRAME.h + FRAME.br;
  }

  const edge = paint('rule', FRAME.v);
  const rows = [paint('rule', top)];
  for (let index = 0; index < bodyHeight; index++) {
    const content = truncate(body[index] || '', inner, GLYPHS.ellipsis);
    const pad = ' '.repeat(Math.max(0, inner - visibleWidth(content)));
    rows.push(`${edge} ${content}${pad} ${edge}`);
  }
  rows.push(paint('rule', bottom));
  return rows;
}

export function dialogHint(extra = '') {
  const parts = ['↑↓ move', 'enter select', 'esc close'];
  if (extra) parts.push(extra);
  return parts.join(`  ${GLYPHS.dot}  `);
}

export { bold, dim };
