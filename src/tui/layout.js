import { visibleWidth, truncate } from './text.js';
/** Keep the composer readable on wide terminals and usable on narrow ones. */
export function composerWidth(columns) {
    const width = Number.isFinite(columns) ? Math.floor(columns) : 80;
    return Math.max(20, Math.min(82, width - 2));
}
/** Center one content column without centering each line independently. */
export function centerRows(rows, columns) {
    const available = Number.isFinite(columns) ? Math.max(1, Math.floor(columns)) : 80;
    const occupied = rows.reduce((widest, row) => Math.max(widest, visibleWidth(row)), 0);
    const inset = Math.max(0, Math.floor((available - occupied) / 2));
    const prefix = ' '.repeat(inset);
    return { rows: rows.map(row => row ? prefix + row : ''), inset };
}
/** Conversation content starts at the left margin while Home stays centered. */
export function sessionRows(rows, columns) {
    const available = Number.isFinite(columns) ? Math.max(1, Math.floor(columns)) : 80;
    const inset = Math.min(2, Math.max(0, available - 2));
    const prefix = ' '.repeat(inset);
    return {
        rows: rows.map(row => row ? prefix + truncate(row, Math.max(1, available - inset - 1), '') : ''),
        inset
    };
}
/** Leave room for a centered home composition without overflowing small terminals. */
export function openingTopGap(rows, introRows) {
    if (!Number.isFinite(rows) || rows < 40)
        return 0;
    return Math.max(0, Math.min(40, Math.floor((rows - introRows - 8) / 2)));
}
/** Place the home composition as one centered group, with room for the composer below. */
export function openingRows(rows, columns, terminalRows) {
    return [
        ...Array(openingTopGap(terminalRows, rows.length)).fill(''),
        ...centerRows(rows, columns).rows
    ];
}
/** Fit every dialog, including text reports, inside the current terminal width. */
export function dialogWidth(columns, requested) {
    const available = Number.isFinite(columns) ? Math.max(4, Math.floor(columns) - 1) : 79;
    return Math.max(4, Math.min(available, Math.floor(requested) || available));
}
export function dialogHeight(available, requested) {
    const room = Number.isFinite(available) ? Math.max(4, Math.floor(available) - 1) : 20;
    return Math.max(4, Math.min(20, room, Math.floor(requested) || room));
}
