import { safeDisplay, visibleWidth, wrapBlock } from './text.js';
/** Render provider activity inside the conversation column, including multiline commands. */
export function activityRows(message, columns, prefix = '▸ ') {
    const width = Number.isFinite(columns) ? Math.max(20, Math.floor(columns)) : 80;
    const inset = visibleWidth(prefix);
    const bodyWidth = Math.max(1, width - inset - 1);
    const lines = wrapBlock(safeDisplay(message).trim(), bodyWidth, { hang: 2 });
    return lines.map((line, index) => `${index === 0 ? prefix : ' '.repeat(inset)}${line}`);
}
