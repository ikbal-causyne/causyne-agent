import { safeDisplay, truncate, visibleWidth, wrap, wrapBlock } from './text.js';

/** Render provider activity inside the conversation column, including multiline commands. */
export function activityRows(message: string, columns: number, prefix = '▸ '): string[] {
  const width = Number.isFinite(columns) ? Math.max(4, Math.floor(columns)) : 80;
  const safePrefix = truncate(safeDisplay(String(prefix ?? '')).replace(/\r?\n/g, ' '), Math.max(1, width - 2), '');
  const inset = visibleWidth(safePrefix);
  const bodyWidth = Math.max(1, width - inset - 1);
  // wrapBlock keeps indentation but assumes at least eight columns.
  // Hard-wrap its output when the actual conversation width is narrower.
  const lines = wrapBlock(safeDisplay(String(message ?? '')).trim(), bodyWidth, { hang: 0 })
    .flatMap(line => wrap(line, bodyWidth));
  return lines.map((line, index) => `${index === 0 ? safePrefix : ' '.repeat(inset)}${line}`);
}
