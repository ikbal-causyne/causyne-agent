import { sessionBanner } from './banner.js';
import { centerRows } from './layout.js';
import { fitHomeContent } from './composerGeometry.js';
import { panelRows } from './overlay.js';
/** A modal before the first conversation belongs to the centered home view. */
export function isStartupDialog(surface) {
    if (!surface)
        return false;
    if (surface.homeInfo)
        return true;
    return !surface.transcript?.frames?.some(frame => frame.kind === 'user' || frame.kind === 'assistant');
}
/** Keep startup pickers readable without letting a long catalogue resize the UI. */
export function startupDialogView(layer, columns, terminalRows) {
    const availableWidth = Number.isFinite(columns) ? Math.max(8, Math.floor(columns) - 1) : 79;
    const availableHeight = Number.isFinite(terminalRows) ? Math.max(4, Math.floor(terminalRows) - 2) : 20;
    const width = Math.min(availableWidth, 96, Math.max(88, Math.floor(layer.width || 0)));
    const height = Math.min(availableHeight, 30);
    const measuredLayer = {
        title: layer.title,
        footer: layer.footer,
        preferredHeight: () => Math.max(10, layer.preferredHeight()),
        body: (innerWidth, bodyHeight) => layer.body(innerWidth, bodyHeight)
    };
    const centered = centerRows(panelRows(measuredLayer, width, height), columns);
    const cursor = layer.cursor;
    return {
        rows: centered.rows,
        caretRow: cursor ? 1 + cursor.y : 0,
        caretCol: centered.inset + (cursor ? 2 + cursor.x : 0)
    };
}
/** Center a temporary dialog in the available terminal region. */
export function placeDialog(rows, columns, height, caretRow, caretCol) {
    const safeHeight = Number.isFinite(height) ? height : 1;
    const safeColumns = Number.isFinite(columns) ? columns : 2;
    const safeCaretRow = Number.isFinite(caretRow) ? caretRow : 0;
    const safeCaretCol = Number.isFinite(caretCol) ? caretCol : 0;
    const available = Math.max(1, Math.floor(safeHeight));
    const shown = rows.slice(0, available);
    const top = Math.max(0, Math.floor((available - shown.length) / 2));
    return {
        rows: [...Array(top).fill(''), ...shown],
        caretRow: top + Math.max(0, Math.min(safeCaretRow, shown.length - 1)),
        caretCol: Math.max(0, Math.min(safeCaretCol, safeColumns - 2))
    };
}
/** A clean first screen; session messages are intentionally absent. */
export function placeHome(info, promptRows, columns, height, caretRow, caretCol) {
    const available = Math.max(1, Math.floor(height));
    const logo = centerRows(sessionBanner(info, columns, { height: available }), columns).rows;
    const spacer = available >= 25 ? 2 : 1;
    // When the window is short, preserve the composer and editing caret first.
    // The logo yields height; it must never push a wrapped draft off-screen.
    const fitted = fitHomeContent(logo, promptRows, available, caretRow, spacer);
    const required = fitted.logoRows.length + fitted.spacer + fitted.promptRows.length;
    const top = Math.max(0, Math.floor((available - required) / 2));
    const rows = [
        ...Array(top).fill(''),
        ...fitted.logoRows,
        ...Array(fitted.spacer).fill(''),
        ...fitted.promptRows
    ];
    return {
        rows,
        caretRow: top + fitted.logoRows.length + fitted.spacer + fitted.caretRow,
        caretCol: Math.max(0, Math.min(caretCol, columns - 2))
    };
}
