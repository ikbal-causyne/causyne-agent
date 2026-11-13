import { safeDisplay, visibleWidth, wrap, wrapBlock } from './text.js';
/** Render provider activity inside the conversation column, including multiline commands. */
export function activityRows(message, columns, prefix = '▸ ') {
    const width = Number.isFinite(columns) ? Math.max(4, Math.floor(columns)) : 80;
    const inset = visibleWidth(prefix);
    const bodyWidth = Math.max(1, width - inset - 1);
      // wrapBlock keeps indentation but assumes at least eight columns.
    // Hard-wrap its output when the actual conversation width is narrower.
    const lines = wrapBlock(safeDisplay(message).trim(), bodyWidth, { hang: 0 })
        .flatMap(line => wrap(line, bodyWidth));
    return lines.map((line, index) => `${index === 0 ? prefix : ' '.repeat(inset)}${line}`);
}
