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
import { truncate, visibleWidth } from './text.js';
import { writeClipboardSync, readClipboardSync } from './clipboardSync.js';
/** Split into code points, so one emoji is one editable unit. */
function toCodePoints(text) {
    return Array.from(String(text == null ? '' : text));
}
function normalizeNewlines(text) {
    return String(text == null ? '' : text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}
// A "word" for word-wise movement. Deliberately generous: an identifier, a
// path segment and a flag should each move as one unit.
const WORD_CHARACTER = /[\p{L}\p{N}_-]/u;
const MAX_BUFFER_CHARS = 2 * 1024 * 1024;
function isInsideRange(lineIdx, colIdx, { start, end }) {
    if (lineIdx < start.line || lineIdx > end.line)
        return false;
    if (lineIdx === start.line && lineIdx === end.line) {
        return colIdx >= start.col && colIdx < end.col;
    }
    if (lineIdx === start.line)
        return colIdx >= start.col;
    if (lineIdx === end.line)
        return colIdx < end.col;
    return true;
}
function renderCellGlyph(ch) {
    if (!ch)
        return '';
    if (ch === '\t')
        return '  ';
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f))
        return '';
    return ch;
}
export class LineEditor {
    lines;
    line;
    col;
    killRing;
    selectionAnchor;
    disableClipboard;
    constructor(initial = '', options) {
        this.lines = [[]];
        this.line = 0;
        this.col = 0;
        this.killRing = '';
        this.selectionAnchor = null;
        this.disableClipboard = options?.disableClipboard === true;
        this.setText(initial);
    }
    // -------------------------------------------------------------------------
    // Content
    // -------------------------------------------------------------------------
    setText(text) {
        const normalized = normalizeNewlines(text);
        const bounded = normalized.length > MAX_BUFFER_CHARS ? normalized.slice(0, MAX_BUFFER_CHARS) : normalized;
        this.lines = bounded.split('\n').map(toCodePoints);
        if (this.lines.length === 0)
            this.lines = [[]];
        this.line = this.lines.length - 1;
        this.col = this.lines[this.line]?.length ?? 0;
        this.selectionAnchor = null;
    }
    getText() {
        return this.lines.map((line) => line.join('')).join('\n');
    }
    get isEmpty() {
        return this.lines.length === 1 && (this.lines[0]?.length ?? 0) === 0;
    }
    get hasSelection() {
        return Boolean(this.selectionAnchor &&
            (this.selectionAnchor.line !== this.line || this.selectionAnchor.col !== this.col));
    }
    _clampPos(pos) {
        const maxLine = Math.max(0, this.lines.length - 1);
        const rawLine = typeof pos?.line === 'number' && Number.isFinite(pos.line) ? Math.floor(pos.line) : 0;
        const line = Math.max(0, Math.min(maxLine, rawLine));
        const maxCol = this.lines[line]?.length ?? 0;
        const rawCol = typeof pos?.col === 'number' && Number.isFinite(pos.col) ? Math.floor(pos.col) : 0;
        const col = Math.max(0, Math.min(maxCol, rawCol));
        return { line, col };
    }
    getSelectionRange() {
        if (!this.hasSelection || !this.selectionAnchor)
            return null;
        const a = this._clampPos(this.selectionAnchor);
        const b = this._clampPos({ line: this.line, col: this.col });
        if (a.line === b.line && a.col === b.col)
            return null;
        if (a.line < b.line || (a.line === b.line && a.col <= b.col)) {
            return { start: a, end: b };
        }
        return { start: b, end: a };
    }
    getSelectedText() {
        const range = this.getSelectionRange();
        if (!range)
            return '';
        const { start, end } = range;
        if (start.line === end.line) {
            return (this.lines[start.line] ?? []).slice(start.col, end.col).join('');
        }
        const parts = [];
        parts.push((this.lines[start.line] ?? []).slice(start.col).join(''));
        for (let i = start.line + 1; i < end.line; i++) {
            parts.push((this.lines[i] ?? []).join(''));
        }
        parts.push((this.lines[end.line] ?? []).slice(0, end.col).join(''));
        return parts.join('\n');
    }
    clearSelection() {
        this.selectionAnchor = null;
    }
    deleteSelection() {
        const range = this.getSelectionRange();
        if (!range)
            return false;
        const { start, end } = range;
        const firstLine = (this.lines[start.line] ?? []).slice(0, start.col);
        const lastLine = (this.lines[end.line] ?? []).slice(end.col);
        const merged = firstLine.concat(lastLine);
        this.lines.splice(start.line, end.line - start.line + 1, merged);
        if (this.lines.length === 0)
            this.lines = [[]];
        this.line = start.line;
        this.col = start.col;
        this.selectionAnchor = null;
        return true;
    }
    selectAll() {
        if (this.isEmpty)
            return;
        this.selectionAnchor = { line: 0, col: 0 };
        this.line = this.lines.length - 1;
        this.col = this.lines[this.line]?.length ?? 0;
    }
    clear() {
        this.lines = [[]];
        this.line = 0;
        this.col = 0;
        this.selectionAnchor = null;
    }
    /** Insert text at the cursor. Embedded newlines split the line, as a paste does. */
    insert(text) {
        if (this.hasSelection)
            this.deleteSelection();
        const currentLength = this.getText().length;
        const remaining = Math.max(0, MAX_BUFFER_CHARS - currentLength);
        if (remaining === 0)
            return;
        const rawNormalized = normalizeNewlines(text);
        const normalized = rawNormalized.length > remaining ? rawNormalized.slice(0, remaining) : rawNormalized;
        const parts = normalized.split('\n');
        const current = this.lines[this.line] ?? [];
        const before = current.slice(0, this.col);
        const after = current.slice(this.col);
        if (parts.length === 1) {
            const codePoints = toCodePoints(parts[0] ?? '');
            this.lines[this.line] = before.concat(codePoints, after);
            this.col += codePoints.length;
            return;
        }
        const inserted = parts.map(toCodePoints);
        const firstInserted = inserted[0] ?? [];
        const lastInserted = inserted[inserted.length - 1] ?? [];
        const first = before.concat(firstInserted);
        const last = lastInserted.concat(after);
        const middle = inserted.slice(1, -1);
        this.lines.splice(this.line, 1, first, ...middle, last);
        this.line += parts.length - 1;
        this.col = lastInserted.length;
    }
    newline() {
        if (this.hasSelection)
            this.deleteSelection();
        const current = this.lines[this.line] ?? [];
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
        const current = this.lines[this.line] ?? [];
        if (this.col > 0) {
            current.splice(this.col - 1, 1);
            this.col -= 1;
            return;
        }
        if (this.line === 0)
            return;
        // Joining lines: the cursor lands where the two met.
        const removed = this.lines.splice(this.line, 1)[0] ?? [];
        this.line -= 1;
        const prev = this.lines[this.line] ?? [];
        this.col = prev.length;
        this.lines[this.line] = prev.concat(removed);
    }
    deleteForward() {
        if (this.hasSelection) {
            this.deleteSelection();
            return;
        }
        const current = this.lines[this.line] ?? [];
        if (this.col < current.length) {
            current.splice(this.col, 1);
            return;
        }
        if (this.line >= this.lines.length - 1)
            return;
        const next = this.lines.splice(this.line + 1, 1)[0] ?? [];
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
        }
        else if (this.selectionAnchor) {
            this.selectionAnchor = null;
        }
    }
    moveTo(line, col, extend = false) {
        this._trackSelection(extend);
        const safeLine = Number.isFinite(line) ? Math.floor(line) : this.line;
        const safeCol = Number.isFinite(col) ? Math.floor(col) : this.col;
        this.line = Math.max(0, Math.min(this.lines.length - 1, safeLine));
        this.col = Math.max(0, Math.min(this.lines[this.line]?.length ?? 0, safeCol));
    }
    moveLeft(extend = false) {
        this._trackSelection(extend);
        if (this.col > 0) {
            this.col -= 1;
            return;
        }
        if (this.line > 0) {
            this.line -= 1;
            this.col = this.lines[this.line]?.length ?? 0;
        }
    }
    moveRight(extend = false) {
        this._trackSelection(extend);
        const currentLen = this.lines[this.line]?.length ?? 0;
        if (this.col < currentLen) {
            this.col += 1;
            return;
        }
        if (this.line < this.lines.length - 1) {
            this.line += 1;
            this.col = 0;
        }
    }
    moveUp(extend = false) {
        this._trackSelection(extend);
        if (this.line === 0) {
            if (extend)
                this.col = 0;
            return false;
        }
        this.line -= 1;
        this.col = Math.min(this.col, this.lines[this.line]?.length ?? 0);
        return true;
    }
    moveDown(extend = false) {
        this._trackSelection(extend);
        if (this.line >= this.lines.length - 1) {
            if (extend)
                this.col = this.lines[this.line]?.length ?? 0;
            return false;
        }
        this.line += 1;
        this.col = Math.min(this.col, this.lines[this.line]?.length ?? 0);
        return true;
    }
    moveHome(extend = false) {
        this._trackSelection(extend);
        this.col = 0;
    }
    moveEnd(extend = false) {
        this._trackSelection(extend);
        this.col = this.lines[this.line]?.length ?? 0;
    }
    moveWordLeft(extend = false) {
        this._trackSelection(extend);
        const line = this.lines[this.line] ?? [];
        if (this.col === 0) {
            if (this.line > 0) {
                this.line -= 1;
                this.col = this.lines[this.line]?.length ?? 0;
            }
            return;
        }
        let index = this.col;
        while (index > 0 && !WORD_CHARACTER.test(line[index - 1] ?? ''))
            index -= 1;
        while (index > 0 && WORD_CHARACTER.test(line[index - 1] ?? ''))
            index -= 1;
        this.col = index;
    }
    moveWordRight(extend = false) {
        this._trackSelection(extend);
        const line = this.lines[this.line] ?? [];
        if (this.col === line.length) {
            if (this.line < this.lines.length - 1) {
                this.line += 1;
                this.col = 0;
            }
            return;
        }
        let index = this.col;
        while (index < line.length && !WORD_CHARACTER.test(line[index] ?? ''))
            index += 1;
        while (index < line.length && WORD_CHARACTER.test(line[index] ?? ''))
            index += 1;
        this.col = index;
    }
    // -------------------------------------------------------------------------
    // Kill and yank — the readline bindings a terminal user already has muscle
    // memory for. Killed text goes to a ring so Ctrl+Y can put it back.
    // -------------------------------------------------------------------------
    _writeClipboardSafe(value) {
        if (this.disableClipboard || !value)
            return;
        try {
            writeClipboardSync(value);
        }
        catch { /* clipboard unavailable */ }
    }
    _killSelection() {
        const killed = this.getSelectedText();
        this.deleteSelection();
        if (!this.disableClipboard) {
            this.killRing = killed;
            this._writeClipboardSafe(this.killRing);
        }
    }
    killToEnd() {
        if (this.hasSelection) {
            this._killSelection();
            return;
        }
        const line = this.lines[this.line] ?? [];
        const killed = line.slice(this.col).join('');
        this.lines[this.line] = line.slice(0, this.col);
        if (!this.disableClipboard) {
            this.killRing = killed;
            this._writeClipboardSafe(this.killRing);
        }
    }
    killToStart() {
        if (this.hasSelection) {
            this._killSelection();
            return;
        }
        const line = this.lines[this.line] ?? [];
        const killed = line.slice(0, this.col).join('');
        this.lines[this.line] = line.slice(this.col);
        this.col = 0;
        if (!this.disableClipboard) {
            this.killRing = killed;
            this._writeClipboardSafe(this.killRing);
        }
    }
    killWordLeft() {
        if (this.hasSelection) {
            this._killSelection();
            return;
        }
        if (this.col === 0) {
            if (this.line > 0) {
                this.backspace();
                if (!this.disableClipboard) {
                    this.killRing = '\n';
                    this._writeClipboardSafe(this.killRing);
                }
            }
            return;
        }
        const start = this.col;
        this.moveWordLeft();
        const line = this.lines[this.line] ?? [];
        const killed = line.slice(this.col, start).join('');
        line.splice(this.col, start - this.col);
        if (!this.disableClipboard) {
            this.killRing = killed;
            this._writeClipboardSafe(this.killRing);
        }
    }
    yank() {
        if (!this.killRing) {
            try {
                const clip = readClipboardSync();
                if (clip)
                    this.killRing = clip;
            }
            catch {
                // Clipboard helper failure must never break editing.
            }
        }
        if (this.killRing)
            this.insert(this.killRing);
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
        const usable = Number.isFinite(width) && width > 0 ? Math.max(8, Math.floor(width)) : 8;
        const rows = [];
        let cursorRow = 0;
        let cursorCol = 0;
        const range = this.getSelectionRange();
        for (let index = 0; index < this.lines.length; index++) {
            const rawPrefix = index === 0 ? '' : String(continuation ?? '');
            const prefix = visibleWidth(rawPrefix) >= usable ? truncate(rawPrefix, usable - 1, '') : rawPrefix;
            const prefixWidth = visibleWidth(prefix);
            const budget = Math.max(1, usable - prefixWidth);
            const line = this.lines[index] ?? [];
            const isCurrentLine = index === this.line;
            let row = prefix;
            let used = 0;
            let placed = false;
            let pos = 0;
            while (pos <= line.length) {
                if (pos === line.length) {
                    if (isCurrentLine && pos === this.col && !placed) {
                        // An exact-width final row has no cell after its last glyph.
                        // Move the caret onto an empty continuation row instead of
                        // positioning it outside the editing surface. Preserve text.
                        if (used >= budget && pos > 0) {
                            rows.push(row);
                            row = prefix;
                            used = 0;
                        }
                        cursorRow = rows.length;
                        cursorCol = Math.min(usable - 1, prefixWidth + used);
                        placed = true;
                    }
                    break;
                }
                const isSpace = /\s/.test(line[pos] ?? '');
                let nextPos = pos;
                let tokenWidth = 0;
                while (nextPos < line.length && (/\s/.test(line[nextPos] ?? '') === isSpace)) {
                    tokenWidth += visibleWidth(renderCellGlyph(line[nextPos] ?? ''));
                    nextPos++;
                }
                // If non-whitespace word exceeds remaining space on non-empty line: wrap to next line first!
                if (used > 0 && used + tokenWidth > budget && !isSpace) {
                    rows.push(row);
                    row = prefix;
                    used = 0;
                }
                while (pos < nextPos) {
                    const glyph = renderCellGlyph(line[pos] ?? '');
                    const charWidth = visibleWidth(glyph);
                    if (used + charWidth > budget && used > 0) {
                        rows.push(row);
                        row = prefix;
                        used = 0;
                    }
                    if (isCurrentLine && pos === this.col && !placed) {
                        cursorRow = rows.length;
                        cursorCol = Math.min(usable - 1, prefixWidth + used);
                        placed = true;
                    }
                    const isSelected = range ? isInsideRange(index, pos, range) : false;
                    row += isSelected && glyph ? `\x1b[7m${glyph}\x1b[27m` : glyph;
                    used += charWidth;
                    pos++;
                }
            }
            rows.push(row);
            if (isCurrentLine && !placed) {
                cursorRow = rows.length - 1;
                cursorCol = Math.min(usable - 1, prefixWidth + used);
            }
        }
        return { rows, cursorRow, cursorCol };
    }
}
