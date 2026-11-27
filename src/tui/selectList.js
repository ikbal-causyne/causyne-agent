// Filterable, fuzzy-scored list primitive shared across all TUI pickers
// (command palette, model picker, session list, theme list, agent list, MCP list).
//
// Scores consecutive letters and word starts higher than scattered matches so
// short queries jump directly to the intended item.
//
// Pure Node over ./theme.js and ./text.js. No dependency, no shell.
import { paint, bold, dim, GLYPHS } from './theme.js';
import { truncate, visibleWidth, safeDisplay } from './text.js';
import { readClipboardSync } from './clipboardSync.js';
const MAX_QUERY_LENGTH = 512;
const cleanSelectText = (value) => (value == null ? '' : safeDisplay(String(value)).replace(/\s+/g, ' ').trim());
/**
 * Score `query` against `text` as a fuzzy subsequence.
 *
 * Returns { score, positions } or null when the query is not a subsequence.
 * Higher is better. The weights are the conventional ones and they matter:
 *
 *   +16 the match continues the previous one (consecutive letters)
 *   +12 the match is at a word start (after a space, -, _, /, or a case bump)
 *   +8  the match is the very first character
 *   -1  per character skipped, so a tight match beats a scattered one
 */
export function fuzzyScore(query, text) {
    const needle = String(query || '').toLowerCase();
    const haystack = String(text || '');
    if (needle === '')
        return { score: 0, positions: [] };
    const lower = haystack.toLowerCase();
    const positions = [];
    let score = 0;
    let cursor = 0;
    let previous = -2;
    for (const character of needle) {
        if (character === ' ')
            continue; // spaces separate words, they do not match
        const found = lower.indexOf(character, cursor);
        if (found === -1)
            return null;
        if (found === previous + 1)
            score += 16;
        if (found === 0)
            score += 8;
        const before = haystack[found - 1];
        const currentChar = haystack[found];
        if (before !== undefined && currentChar !== undefined) {
            const isBoundary = /[\s\-_/.:]/.test(before)
                || (before === before.toLowerCase() && currentChar === currentChar.toUpperCase()
                    && currentChar !== currentChar.toLowerCase());
            if (isBoundary)
                score += 12;
        }
        score -= Math.min(found - cursor, 8);
        positions.push(found);
        previous = found;
        cursor = found + 1;
    }
    // A shorter label containing the same letters is the more likely target.
    score -= Math.floor(haystack.length / 12);
    return { score, positions };
}
/** Filter and rank items. Items keep their original order when the query is empty. */
export function fuzzyFilter(items, query) {
    const safeItems = Array.isArray(items) ? items.filter((entry) => Boolean(entry)) : [];
    if (!query)
        return safeItems.map((item, index) => ({ item, score: 0, positions: [], index }));
    const scored = [];
    for (let index = 0; index < safeItems.length; index++) {
        const item = safeItems[index];
        if (!item)
            continue;
        const subject = `${item.label || ''} ${item.searchText || ''} ${item.category || ''}`.trim();
        const result = fuzzyScore(query, subject);
        if (result)
            scored.push({ item, score: result.score, positions: result.positions, index });
    }
    // Stable: equal scores keep the order they were declared in.
    scored.sort((a, b) => (b.score - a.score) || (a.index - b.index));
    return scored;
}
export class SelectList {
    all;
    filtered;
    query;
    selected;
    offset;
    placeholder;
    emptyText;
    showFilter;
    lastInnerWidth;
    lastItemRows;
    /**
     * items: { label, description, category, hint, value, searchText, disabled }
     */
    constructor(items = [], options = {}) {
        const opts = options && typeof options === 'object' ? options : {};
        this.all = [];
        this.filtered = [];
        this.query = '';
        this.selected = 0;
        this.offset = 0;
        this.placeholder = opts.placeholder || 'type to filter';
        this.emptyText = opts.emptyText || 'no matches';
        this.showFilter = opts.showFilter !== false;
        this.setItems(items);
    }
    setItems(items) {
        this.all = Array.isArray(items) ? items.filter((entry) => Boolean(entry)) : [];
        this.refilter();
        return this;
    }
    refilter() {
        this.filtered = fuzzyFilter(this.all, this.query);
        this.selected = Math.min(this.selected || 0, Math.max(0, this.filtered.length - 1));
        this.offset = 0;
        return this;
    }
    get current() {
        const entry = this.filtered[this.selected];
        return entry ? entry.item : null;
    }
    move(delta, visibleRows) {
        const count = this.filtered.length;
        if (count === 0 || !Number.isFinite(delta))
            return this;
        const step = Math.trunc(delta);
        // Wrapping is what makes a short list feel responsive: pressing up on the
        // first row lands on the last, instead of doing nothing.
        this.selected = (((this.selected + step) % count) + count) % count;
        this.ensureVisible(visibleRows);
        return this;
    }
    moveTo(index, visibleRows) {
        if (this.filtered.length === 0 || !Number.isFinite(index))
            return this;
        this.selected = Math.max(0, Math.min(Math.floor(index), this.filtered.length - 1));
        this.ensureVisible(visibleRows);
        return this;
    }
    /**
     * How many items starting at `from` actually fit in `rows` rendered rows.
     *
     * render() emits a category header whenever the group changes, so a window of
     * N items does NOT occupy N rows. Counting items and rendering rows are two
     * different quantities, and treating them as one is what made the selection
     * marker disappear: ensureVisible() put the selected item at the end of an
     * item-counted window, the render loop ran out of ROWS on the headers before
     * it reached that item, and the marker was simply never drawn. Pressing up
     * moved the selection back into the part that had been drawn, which is why it
     * came back.
     */
    renderableCount(from, rows) {
        const budget = Math.max(1, rows);
        let used = 0;
        let count = 0;
        let lastCategory = null;
        for (let index = from; index < this.filtered.length; index++) {
            const entry = this.filtered[index];
            if (!entry)
                continue;
            const item = entry.item;
            const needed = (item.category && item.category !== lastCategory) ? 2 : 1;
            if (used + needed > budget)
                break;
            if (item.category)
                lastCategory = item.category;
            used += needed;
            count++;
        }
        return count;
    }
    ensureVisible(visibleRows) {
        const rows = typeof visibleRows === 'number' && Number.isFinite(visibleRows) && visibleRows > 0
            ? Math.max(1, Math.floor(visibleRows))
            : 10;
        if (this.filtered.length === 0) {
            this.offset = 0;
            return this;
        }
        if (this.selected < this.offset)
            this.offset = this.selected;
        // Scroll down until the selected item is genuinely among the ones that will
        // be drawn — measured in rows, headers included, not in items.
        let guard = this.filtered.length;
        while (guard-- > 0 &&
            this.offset < this.selected &&
            this.selected >= this.offset + this.renderableCount(this.offset, rows)) {
            this.offset++;
        }
        // Never scroll past the selection: the old clamp to
        // `filtered.length - rows` was item-counted too, and could pull the offset
        // back to a position where the selection was off-window again.
        this.offset = Math.max(0, Math.min(this.offset, this.selected));
        return this;
    }
    /**
     * Feed a decoded key. Returns 'select' | 'cancel' | 'handled' | null.
     *
     * null means the key was not ours, which is how the caller knows it may pass
     * the key on. A dialog that swallows every key is a dialog you cannot escape.
     */
    handleKey(key, visibleRows) {
        if (!key)
            return null;
        const rows = typeof visibleRows === 'number' && Number.isFinite(visibleRows) && visibleRows > 0
            ? Math.max(1, Math.floor(visibleRows))
            : 10;
        switch (key.name) {
            case 'up':
                this.move(-1, rows);
                return 'handled';
            case 'down':
                this.move(1, rows);
                return 'handled';
            case 'wheel': {
                const direction = key.wheel && key.wheel.direction;
                if (direction === 'up')
                    this.moveTo(this.selected - 1, rows);
                else if (direction === 'down')
                    this.moveTo(this.selected + 1, rows);
                return 'handled';
            }
            // A page is the number of ITEMS on screen, not the number of rows.
            // Category headers spend rows without being selectable, so paging by the
            // row budget jumped further than a screenful and left a band of items that
            // could not be reached by paging at all.
            case 'pageup':
            case 'pagedown': {
                const page = Math.max(1, this.renderableCount(this.offset, rows));
                this.move(key.name === 'pageup' ? -page : page, rows);
                return 'handled';
            }
            case 'home':
                this.moveTo(0, rows);
                return 'handled';
            case 'end':
                this.moveTo(this.filtered.length - 1, rows);
                return 'handled';
            // keys.js emits 'enter' (see makeKey('enter', …) for both CR and LF).
            // This listened only for 'return', a name the decoder never produces, so
            // Enter fell through to the printable-character branch, was rejected there
            // for being a control byte, and returned null — a completely dead key.
            // Nothing in the picker or the command palette could ever be selected.
            // 'return' is kept so a decoder that emits it still works.
            case 'enter':
            case 'return': return this.current ? 'select' : 'handled';
            case 'escape': return 'cancel';
            case 'backspace':
                if (this.query.length > 0) {
                    this.query = this.query.slice(0, -1);
                    this.refilter();
                    return 'handled';
                }
                return 'cancel';
            case 'paste': {
                const clean = cleanSelectText(key.text);
                if (clean) {
                    this.query = (this.query + clean).slice(0, MAX_QUERY_LENGTH);
                    this.refilter();
                }
                return 'handled';
            }
            default: break;
        }
        // Emacs navigation, which both references bind and terminal users expect.
        if (key.ctrl) {
            if (key.name === 'p') {
                this.move(-1, rows);
                return 'handled';
            }
            if (key.name === 'n') {
                this.move(1, rows);
                return 'handled';
            }
            if (key.name === 'u') {
                this.query = '';
                this.refilter();
                return 'handled';
            }
            if (key.name === 'v') {
                let text = '';
                try {
                    text = readClipboardSync() || '';
                }
                catch {
                    text = '';
                }
                if (text) {
                    const clean = cleanSelectText(text);
                    if (clean) {
                        this.query = (this.query + clean).slice(0, MAX_QUERY_LENGTH);
                        this.refilter();
                    }
                }
                return 'handled';
            }
            return null;
        }
        const typed = key.name === 'char' && !key.ctrl && !key.alt && !key.meta && typeof key.text === 'string'
            ? key.text
            : (typeof key.sequence === 'string' && key.sequence.length === 1 && key.sequence >= ' ' && !key.meta ? key.sequence : '');
        if (typed) {
            const safe = safeDisplay(typed).replace(/[\r\n\t]+/g, ' ');
            if (safe) {
                this.query = (this.query + safe).slice(0, MAX_QUERY_LENGTH);
                this.refilter();
            }
            return 'handled';
        }
        return null;
    }
    /**
     * Render into an array of styled rows for a panel `width` x `height`.
     *
     * Returns { rows, listRows } — the caret sits in the filter field, which
     * is the only place a caret belongs in a picker.
     */
    render(width, height) {
        const safeWidth = Number.isFinite(width) && width > 0 ? Math.floor(width) : 8;
        const safeHeight = Number.isFinite(height) && height > 0 ? Math.floor(height) : 4;
        const rows = [];
        const inner = Math.max(4, safeWidth);
        this.lastInnerWidth = inner;
        if (this.showFilter) {
            const shown = cleanSelectText(this.query) || dim(cleanSelectText(this.placeholder));
            rows.push(`${paint('accent', GLYPHS.arrow)} ${truncate(shown, inner - 2, GLYPHS.ellipsis)}`);
            rows.push(paint('rule', GLYPHS.hLine.repeat(inner)));
        }
        // Rows the ITEM loop may use.
        //
        // Two rows are already spent on the filter and its rule, and one more is
        // reserved at the bottom for the position counter — which is written with
        // `rows[height - 1] = line`, i.e. it OVERWRITES whatever is on the last row.
        // Letting the loop fill that row meant the counter could clobber the very
        // item the marker was on, which is a second, independent way for the
        // selection to vanish.
        const itemRows = Math.max(1, safeHeight - rows.length - 1);
        // Remember what the renderer actually budgeted, so key handling scrolls by
        // the same number of rows it draws. SelectLayer used to derive its own
        // figure from the layer's configured height, which is not the height the
        // panel ends up giving the body — 17 against the renderer's 15 here.
        this.lastItemRows = itemRows;
        this.ensureVisible(itemRows);
        if (this.filtered.length === 0) {
            if (rows.length + 1 < safeHeight)
                rows.push('');
            if (rows.length < safeHeight) {
                const cleanEmpty = truncate(cleanSelectText(this.emptyText), Math.max(1, inner - 2), GLYPHS.ellipsis);
                rows.push(`  ${dim(cleanEmpty)}`);
            }
            return { rows, listRows: itemRows };
        }
        const windowEntries = this.filtered.slice(this.offset, this.offset + itemRows);
        // The last row belongs to the position counter whenever one is shown.
        const ceiling = this.filtered.length > itemRows ? Math.max(rows.length + 1, safeHeight - 1) : safeHeight;
        let lastCategory = null;
        for (let index = 0; index < windowEntries.length; index++) {
            const entry = windowEntries[index];
            if (!entry)
                continue;
            const item = entry.item;
            const isSelected = this.offset + index === this.selected;
            if (item.category && item.category !== lastCategory) {
                if (rows.length + 2 > ceiling)
                    break;
                lastCategory = item.category;
                rows.push(truncate(dim(`  ${cleanSelectText(item.category)}`), inner, GLYPHS.ellipsis));
            }
            const marker = isSelected ? paint('accent', GLYPHS.arrow) : ' ';
            const label = cleanSelectText(item.label || '');
            const cleanHint = cleanSelectText(item.hint || '');
            const hint = cleanHint ? dim(` ${cleanHint}`) : '';
            const description = item.description ? cleanSelectText(item.description) : '';
            // The hint (a keybinding) is right-aligned, which is what makes a palette
            // scannable: the names line up on the left, the keys on the right.
            const left = `${marker} ${isSelected ? bold(paint('ink', label)) : paint('ink', label)}`;
            const hintWidth = visibleWidth(hint);
            const room = inner - visibleWidth(left) - hintWidth - 2;
            const middle = description && room > 6
                ? dim('  ' + truncate(description, room, GLYPHS.ellipsis))
                : '';
            const padding = Math.max(0, inner - visibleWidth(left) - visibleWidth(middle) - hintWidth);
            rows.push(truncate(left + middle + ' '.repeat(padding) + hint, inner, GLYPHS.ellipsis));
            if (rows.length >= ceiling)
                break;
        }
        // A count is the cheapest possible scroll indicator and it never lies.
        if (this.filtered.length > itemRows) {
            const position = `${this.selected + 1}/${this.filtered.length}`;
            const line = dim(truncate(position.padStart(inner), inner, GLYPHS.ellipsis));
            if (rows.length >= safeHeight)
                rows[safeHeight - 1] = line;
            else
                rows.push(line);
        }
        return { rows, listRows: itemRows };
    }
    /** Column the caret sits at within the filter row. */
    cursorColumn() {
        const maxCol = Math.max(2, (this.lastInnerWidth || 40) - 1);
        return Math.min(maxCol, 2 + visibleWidth(cleanSelectText(this.query)));
    }
}
