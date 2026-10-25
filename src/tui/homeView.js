import { sessionBanner } from './banner.js';
import { centerRows } from './layout.js';
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
