import { safeDisplay, truncate, visibleWidth, wrap } from './text.js';
// The terminal palette remains a JavaScript module during the TypeScript migration.
// @ts-expect-error theme.js does not have a declaration yet.
import { paint } from './theme.js';

export type MessageTone = 'danger' | 'warn' | 'muted' | 'accent';

/** Width of text inside the current conversation column, with room for its inset. */
export function chatTextWidth(columns: number): number {
  const available = Number.isFinite(columns) ? Math.floor(columns) : 80;
  return Math.max(8, available - 4);
}

/** Widen prose gradually on large screens so lines remain readable. */
export function chatProseWidth(columns: number): number {
  const available = Number.isFinite(columns) ? Math.max(20, Math.floor(columns)) : 80;
  if (available <= 100) return available;
  return Math.min(chatTextWidth(available), Math.round(100 + 24 * Math.log2(available / 100)));
}

/** Keep every line of a labeled message visible when the terminal is resized. */
export function wrappedChatRows(message: string, columns: number, prefix: string, tone: MessageTone): string[] {
  const width = chatTextWidth(columns);
  const safePrefix = truncate(
    String(prefix ?? '').replace(/[\x00-\x1a\x1c-\x1f\x7f-\x9f]/g, ' '),
    Math.max(0, width - 1),
    ''
  );
  const inset = visibleWidth(safePrefix);
  const room = Math.max(1, width - inset);
  const continuation = ' '.repeat(inset);
  return wrap(safeDisplay(String(message ?? '')), room).map((line: string, index: number) =>
    `${index === 0 ? safePrefix : continuation}${paint(tone, line)}`);
}
