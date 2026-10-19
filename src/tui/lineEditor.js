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

/** Split into code points, so one emoji is one editable unit. */
function toCodePoints(text) {
  return Array.from(String(text == null ? '' : text));
}

// A "word" for word-wise movement. Deliberately generous: an identifier, a
// path segment and a flag should each move as one unit.
const WORD_CHARACTER = /[\p{L}\p{N}_-]/u;

export class LineEditor {
  constructor(initial = '') {
    this.setText(initial);
    this.killRing = '';
  }

  // -------------------------------------------------------------------------
  // Content
  // -------------------------------------------------------------------------

  setText(text) {
    this.lines = String(text == null ? '' : text).split('\n').map(toCodePoints);
    if (this.lines.length === 0) this.lines = [[]];
    this.line = this.lines.length - 1;
    this.col = this.lines[this.line].length;
  }

  getText() {
    return this.lines.map((line) => line.join('')).join('\n');
  }

  get isEmpty() {
    return this.lines.length === 1 && this.lines[0].length === 0;
  }

  clear() {
    this.lines = [[]];
    this.line = 0;
    this.col = 0;
  }

  /** Insert text at the cursor. Embedded newlines split the line, as a paste does. */
  insert(text) {
    const parts = String(text).split('\n');
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
    const current = this.lines[this.line];
    const before = current.slice(0, this.col);
    const after = current.slice(this.col);
    this.lines.splice(this.line, 1, before, after);
    this.line += 1;
    this.col = 0;
  }

  backspace() {
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

  moveLeft() {
    if (this.col > 0) { this.col -= 1; return; }
    if (this.line > 0) { this.line -= 1; this.col = this.lines[this.line].length; }
  }

  moveRight() {
    if (this.col < this.lines[this.line].length) { this.col += 1; return; }
    if (this.line < this.lines.length - 1) { this.line += 1; this.col = 0; }
  }

  moveUp() {
    if (this.line === 0) return false;
    this.line -= 1;
    this.col = Math.min(this.col, this.lines[this.line].length);
    return true;
  }

  moveDown() {
    if (this.line >= this.lines.length - 1) return false;
    this.line += 1;
    this.col = Math.min(this.col, this.lines[this.line].length);
    return true;
  }

  moveHome() { this.col = 0; }
  moveEnd() { this.col = this.lines[this.line].length; }

  moveWordLeft() {
    const line = this.lines[this.line];
    if (this.col === 0) { this.moveLeft(); return; }
    let index = this.col;
    while (index > 0 && !WORD_CHARACTER.test(line[index - 1])) index -= 1;
    while (index > 0 && WORD_CHARACTER.test(line[index - 1])) index -= 1;
    this.col = index;
  }

  moveWordRight() {
    const line = this.lines[this.line];
    if (this.col === line.length) { this.moveRight(); return; }
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
    const line = this.lines[this.line];
    this.killRing = line.slice(this.col).join('');
    this.lines[this.line] = line.slice(0, this.col);
  }

  killToStart() {
    const line = this.lines[this.line];
    this.killRing = line.slice(0, this.col).join('');
    this.lines[this.line] = line.slice(this.col);
    this.col = 0;
  }

  killWordLeft() {
    const start = this.col;
    this.moveWordLeft();
    const line = this.lines[this.line];
    this.killRing = line.slice(this.col, start).join('');
    line.splice(this.col, start - this.col);
  }

  yank() {
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
        row += character;
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
