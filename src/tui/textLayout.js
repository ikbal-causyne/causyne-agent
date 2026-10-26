import { visibleWidth, wrap } from './text.js';
// The terminal palette remains a JavaScript module during the TypeScript migration.
// @ts-expect-error theme.js does not have a declaration yet.
import { paint } from './theme.js';
/** Width of text inside the current conversation column, with room for its inset. */
export function chatTextWidth(columns) {
    const available = Number.isFinite(columns) ? Math.floor(columns) : 80;
    return Math.max(8, available - 4);
}
/** Widen prose gradually on large screens so lines remain readable. */
export function chatProseWidth(columns) {
    const available = Number.isFinite(columns) ? Math.max(20, Math.floor(columns)) : 80;
    if (available <= 100)
        return available;
    return Math.min(chatTextWidth(available), Math.round(100 + 24 * Math.log2(available / 100)));
}
/** Keep every line of a labeled message visible when the terminal is resized. */
export function wrappedChatRows(message, columns, prefix, tone) {
    const inset = visibleWidth(prefix);
    const room = Math.max(1, chatTextWidth(columns) - inset);
    const continuation = ' '.repeat(inset);
    return wrap(message, room).map((line, index) => `${index === 0 ? prefix : continuation}${paint(tone, line)}`);
}
