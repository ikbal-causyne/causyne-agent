import { truncate, visibleWidth } from './text.js';
/** Overlay a compact menu in the transcript viewport, near the selected message. */
export function placeMessageActionPanel(viewportRows, panel, contentWidth, stageTop, anchorY, count) {
    if (!panel.length || viewportRows.length < panel.length || contentWidth < 8) {
        return { rows: viewportRows, layout: null };
    }
    const width = Math.min(contentWidth, Math.max(...panel.map(visibleWidth)));
    const x = Math.max(0, Math.floor((contentWidth - width) / 2));
    const anchor = anchorY === null ? Math.floor(viewportRows.length / 2) : anchorY - stageTop;
    const y = Math.max(0, Math.min(viewportRows.length - panel.length, anchor - Math.floor(panel.length / 2)));
    const rows = viewportRows.slice();
    for (let i = 0; i < panel.length; i++) {
        rows[y + i] = `${' '.repeat(x)}${truncate(panel[i] ?? '', width, '')}`;
    }
    return { rows, layout: { x, y: stageTop + y, width, count } };
}
