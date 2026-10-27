// A multi-line text buffer with a cursor, and the arithmetic to draw it.
//
// The chat prompt was a single `inquirer` line: no way to write a paragraph, no
// way to fix the start of a sentence without deleting the end of it. This is the
// buffer that replaces it.
//
// The buffer holds CODE POINTS, not UTF-16 units. Storing a JavaScript string
// and moving the cursor by index splits an emoji in half and leaves the terminal
// printing a replacement character — the cursor must move by what the user sees
// as one character.
//
// Drawing is not done here. render() returns the lines and where the cursor
// landed in them; putting bytes on the terminal belongs to prompt.js.
//
// Pure Node. No dependency, no shell.

import { visibleWidth } from './text.js';
import { writeClipboardSync, readClipboardSync } from './clipboardSync.js';

/** Split into code points, so one emoji is one editable unit. */
function toCodePoints(text) {
  return Array.from(String(text == null ? '' : text));
}

// A "word" for word-wise movement. Deliberately generous: an identifier, a
// path segment and a flag should each move as one unit.
const WORD_CHARACTER = /[\p{L}\p{N}_-]/u;

function isInsideRange(lineIdx, colIdx, { start, end }) {
  if (lineIdx < start.line || lineIdx > end.line) return false;
  if (lineIdx === start.line && lineIdx === end.line) {
    return colIdx >= start.col && colIdx < end.col;
  }
  if (lineIdx === start.line) return colIdx >= start.col;
  if (lineIdx === end.line) return colIdx < end.col;
  return true;
}

export class LineEditor {
  constructor(initial = '') {
    this.setText(initial);
    this.killRing = '';
    this.selectionAnchor = null;
  }

  // -------------------------------------------------------------------------
  // Content
  // -------------------------------------------------------------------------

  setText(text) {
    this.lines = String(text == null ? '' : text).split('\n').map(toCodePoints);
    if (this.lines.length === 0) this.lines = [[]];
    this.line = this.lines.length - 1;
    this.col = this.lines[this.line].length;
    this.selectionAnchor = null;
  }

  getText() {
    return this.lines.map((line) => line.join('')).join('\n');
  }

  get isEmpty() {
    return this.lines.length === 1 && this.lines[0].length === 0;
  }

  get hasSelection() {
    return Boolean(
      this.selectionAnchor &&
      (this.selectionAnchor.line !== this.line || this.selectionAnchor.col !== this.col)
    );
  }

  getSelectionRange() {
    if (!this.hasSelection || !this.selectionAnchor) return null;
    const a = this.selectionAnchor;
    const b = { line: this.line, col: this.col };
    if (a.line < b.line || (a.line === b.line && a.col <= b.col)) {
      return { start: { line: a.line, col: a.col }, end: { line: b.line, col: b.col } };
    }
    return { start: { line: b.line, col: b.col }, end: { line: a.line, col: a.col } };
  }

  getSelectedText() {
    const range = this.getSelectionRange();
    if (!range) return '';
    const { start, end } = range;
    if (start.line === end.line) {
      return this.lines[start.line].slice(start.col, end.col).join('');
    }
    const parts = [];
    parts.push(this.lines[start.line].slice(start.col).join(''));
    for (let i = start.line + 1; i < end.line; i++) {
      parts.push(this.lines[i].join(''));
    }
    parts.push(this.lines[end.line].slice(0, end.col).join(''));
    return parts.join('\n');
  }

  clearSelection() {
    this.selectionAnchor = null;
  }

  deleteSelection() {
    const range = this.getSelectionRange();
    if (!range) return false;
    const { start, end } = range;
    const firstLine = this.lines[start.line].slice(0, start.col);
    const lastLine = this.lines[end.line].slice(end.col);
    const merged = firstLine.concat(lastLine);
    this.lines.splice(start.line, end.line - start.line + 1, merged);
    if (this.lines.length === 0) this.lines = [[]];
    this.line = start.line;
    this.col = start.col;
    this.selectionAnchor = null;
    return true;
  }

  selectAll() {
    if (this.isEmpty) return;
    this.selectionAnchor = { line: 0, col: 0 };
    this.line = this.lines.length - 1;
    this.col = this.lines[this.line].length;
  }

  clear() {
    this.lines = [[]];
    this.line = 0;
    this.col = 0;
    this.selectionAnchor = null;
  }

  /** Insert text at the cursor. Embedded newlines split the line, as a paste does. */
  insert(text) {
    if (this.hasSelection) this.deleteSelection();
    const normalized = String(text == null ? '' : text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const parts = normalized.split('\n');
    const current = this.lines[this.line];
    const before = current.slice(0, this.col);
    const after = current.slice(this.col);

    if (parts.length === 1) {
      this.lines[this.line] = before.concat(toCodePoints(parts[0]), after);
      this.col += toCodePoints(parts[0]).length;
      return;
    }

    const inserted = parts.map(toCodePoints);
    const first = before.concat(inserted[0]);
    const last = inserted[inserted.length - 1].concat(after);
    const middle = inserted.slice(1, -1);

    this.lines.splice(this.line, 1, first, ...middle, last);
    this.line += parts.length - 1;
    this.col = inserted[inserted.length - 1].length;
  }

  newline() {
    if (this.hasSelection) this.deleteSelection();
    const current = this.lines[this.line];
    const before = current.slice(0, this.col);
    const after = current.slice(this.col);
    this.lines.splice(this.line, 1, before, after);
    this.line += 1;
    this.col = 0;
  }

  backspace() {
    if (this.hasSelection) {
      this.deleteSelection();
      return;
    }
    if (this.col > 0) {
      this.lines[this.line].splice(this.col - 1, 1);
      this.col -= 1;
      return;
    }
    if (this.line === 0) return;
    // Joining lines: the cursor lands where the two met.
    const removed = this.lines.splice(this.line, 1)[0];
    this.line -= 1;
    this.col = this.lines[this.line].length;
    this.lines[this.line] = this.lines[this.line].concat(removed);
  }

  deleteForward() {
    if (this.hasSelection) {
      this.deleteSelection();
      return;
    }
    const current = this.lines[this.line];
    if (this.col < current.length) {
      current.splice(this.col, 1);
      return;
    }
    if (this.line >= this.lines.length - 1) return;
    const next = this.lines.splice(this.line + 1, 1)[0];
    this.lines[this.line] = current.concat(next);
  }

  // -------------------------------------------------------------------------
  // Movement
  // -------------------------------------------------------------------------

  _trackSelection(extend) {
    if (extend) {
      if (!this.selectionAnchor) {
        this.selectionAnchor = { line: this.line, col: this.col };
      }
    } else if (this.selectionAnchor) {
      this.selectionAnchor = null;
    }
  }

  moveTo(line, col, extend = false) {
    this._trackSelection(extend);
    this.line = Math.max(0, Math.min(this.lines.length - 1, line));
    this.col = Math.max(0, Math.min(this.lines[this.line].length, col));
  }

  moveLeft(extend = false) {
    this._trackSelection(extend);
    if (this.col > 0) { this.col -= 1; return; }
    if (this.line > 0) { this.line -= 1; this.col = this.lines[this.line].length; }
  }

  moveRight(extend = false) {
    this._trackSelection(extend);
    if (this.col < this.lines[this.line].length) { this.col += 1; return; }
    if (this.line < this.lines.length - 1) { this.line += 1; this.col = 0; }
  }

  moveUp(extend = false) {
    this._trackSelection(extend);
    if (this.line === 0) {
      if (extend) this.col = 0;
      return false;
    }
    this.line -= 1;
    this.col = Math.min(this.col, this.lines[this.line].length);
    return true;
  }

  moveDown(extend = false) {
    this._trackSelection(extend);
    if (this.line >= this.lines.length - 1) {
      if (extend) this.col = this.lines[this.line].length;
      return false;
    }
    this.line += 1;
    this.col = Math.min(this.col, this.lines[this.line].length);
    return true;
  }

  moveHome(extend = false) {
    this._trackSelection(extend);
    this.col = 0;
  }

  moveEnd(extend = false) {
    this._trackSelection(extend);
    this.col = this.lines[this.line].length;
  }

  moveWordLeft(extend = false) {
    this._trackSelection(extend);
    const line = this.lines[this.line];
    if (this.col === 0) {
      if (this.line > 0) { this.line -= 1; this.col = this.lines[this.line].length; }
      return;
    }
    let index = this.col;
    while (index > 0 && !WORD_CHARACTER.test(line[index - 1])) index -= 1;
    while (index > 0 && WORD_CHARACTER.test(line[index - 1])) index -= 1;
    this.col = index;
  }

  moveWordRight(extend = false) {
    this._trackSelection(extend);
    const line = this.lines[this.line];
    if (this.col === line.length) {
      if (this.line < this.lines.length - 1) { this.line += 1; this.col = 0; }
      return;
    }
    let index = this.col;
    while (index < line.length && !WORD_CHARACTER.test(line[index])) index += 1;
    while (index < line.length && WORD_CHARACTER.test(line[index])) index += 1;
    this.col = index;
  }

  // -------------------------------------------------------------------------
  // Kill and yank — the readline bindings a terminal user already has muscle
  // memory for. Killed text goes to a ring so Ctrl+Y can put it back.
  // -------------------------------------------------------------------------

  killToEnd() {
    if (this.hasSelection) {
      this.killRing = this.getSelectedText();
      this.deleteSelection();
      if (this.killRing) writeClipboardSync(this.killRing);
      return;
    }
    const line = this.lines[this.line];
    this.killRing = line.slice(this.col).join('');
    this.lines[this.line] = line.slice(0, this.col);
    if (this.killRing) writeClipboardSync(this.killRing);
  }

  killToStart() {
    if (this.hasSelection) {
      this.killRing = this.getSelectedText();
      this.deleteSelection();
      if (this.killRing) writeClipboardSync(this.killRing);
      return;
    }
    const line = this.lines[this.line];
    this.killRing = line.slice(0, this.col).join('');
    this.lines[this.line] = line.slice(this.col);
    this.col = 0;
    if (this.killRing) writeClipboardSync(this.killRing);
  }

  killWordLeft() {
    if (this.hasSelection) {
      this.killRing = this.getSelectedText();
      this.deleteSelection();
      if (this.killRing) writeClipboardSync(this.killRing);
      return;
    }
    const start = this.col;
    this.moveWordLeft();
    const line = this.lines[this.line];
    this.killRing = line.slice(this.col, start).join('');
    line.splice(this.col, start - this.col);
    if (this.killRing) writeClipboardSync(this.killRing);
  }

  yank() {
    if (!this.killRing) {
      const clip = readClipboardSync();
      if (clip) this.killRing = clip;
    }
    if (this.killRing) this.insert(this.killRing);
  }

  // -------------------------------------------------------------------------
  // Layout
  // -------------------------------------------------------------------------

  /**
   * Lay the buffer out for a terminal `width` columns wide.
   *
   * Returns the display rows plus where the cursor ended up in them. A logical
   * line longer than the terminal soft-wraps onto several rows, so display row
   * and logical line are not the same number — mixing them up is what makes a
   * redraw leave debris on screen.
   */
  render(width, continuation = '') {
    const usable = Math.max(8, width);
    const rows = [];
    let cursorRow = 0;
    let cursorCol = 0;
    const range = this.getSelectionRange();

    for (let index = 0; index < this.lines.length; index++) {
      const prefix = index === 0 ? '' : continuation;
      const prefixWidth = visibleWidth(prefix);
      const budget = Math.max(1, usable - prefixWidth);
      const line = this.lines[index];

      let row = prefix;
      let used = 0;
      let placed = false;

      for (let position = 0; position <= line.length; position++) {
        if (index === this.line && position === this.col) {
          cursorRow = rows.length;
          cursorCol = prefixWidth + used;
          placed = true;
        }
        if (position === line.length) break;

        const character = line[position];
        const charWidth = visibleWidth(character);
        if (used + charWidth > budget) {
          rows.push(row);
          row = prefix;
          used = 0;
          // Re-place the cursor if it sat exactly at the wrap point.
          if (placed && cursorRow === rows.length - 1 && cursorCol === prefixWidth + budget) {
            cursorRow = rows.length;
            cursorCol = prefixWidth;
          }
        }
        const isSelected = range ? isInsideRange(index, position, range) : false;
        row += isSelected ? `\x1b[7m${character}\x1b[27m` : character;
        used += charWidth;
      }

      rows.push(row);
      if (index === this.line && !placed) {
        cursorRow = rows.length - 1;
        cursorCol = prefixWidth + used;
      }
    }

    return { rows, cursorRow, cursorCol };
  }
}
