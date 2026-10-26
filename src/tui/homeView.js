import { sessionBanner } from './banner.js';
import { centerRows } from './layout.js';
// @ts-expect-error overlay.js is awaiting TypeScript migration.
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
    const available = Math.max(1, Math.floor(height));
    const shown = rows.slice(0, available);
    const top = Math.max(0, Math.floor((available - shown.length) / 2));
    return {
        rows: [...Array(top).fill(''), ...shown],
        caretRow: top + Math.min(Math.max(0, caretRow), shown.length - 1),
        caretCol: Math.max(0, Math.min(caretCol, columns - 2))
    };
}
/** A clean first screen; session messages are intentionally absent. */
export function placeHome(info, promptRows, columns, height, caretRow, caretCol) {
    const available = Math.max(1, Math.floor(height));
    const logo = centerRows(sessionBanner(info, columns, { height: available }), columns).rows;
    const spacer = available >= 25 ? 2 : 1;
    const required = logo.length + spacer + promptRows.length;
    const top = Math.max(0, Math.floor((available - required) / 2));
    const rows = [
        ...Array(top).fill(''),
        ...logo,
        ...Array(spacer).fill(''),
        ...promptRows
    ];
    return {
        rows: rows.slice(0, available),
        caretRow: Math.min(available - 1, top + logo.length + spacer + Math.max(0, caretRow)),
        caretCol: Math.max(0, Math.min(caretCol, columns - 2))
    };
}
