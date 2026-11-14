import { padEnd, truncate, visibleWidth } from './text.js';
import { sliceFromColumn } from './turnRail.js';
// @ts-expect-error theme has no TypeScript declarations yet
import { HAS_COLOR } from './theme.js';
function dimBackdropRow(row) {
    if (!row || !row.trim())
        return row;
    return `\x1b[2m${row.replace(/\x1b\[0m/g, '\x1b[0m\x1b[2m')}\x1b[0m`;
}
/**
 * Overlay a message action menu in the transcript viewport with adaptive,
 * context-aware positioning and elevated backdrop isolation.
 */
export function placeMessageActionPanel(viewportRows, panel, contentWidth, stageTop, anchorY, count, options) {
    if (!panel.length || viewportRows.length < panel.length || !Number.isFinite(contentWidth) || contentWidth < 8) {
        return { rows: viewportRows, layout: null };
    }
    const safeContentWidth = Math.floor(contentWidth);
    const safeStageTop = Number.isFinite(stageTop) ? Math.floor(stageTop) : 0;
    const safeCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
    const totalRows = viewportRows.length;
    const panelHeight = panel.length;
    const width = Math.min(safeContentWidth, Math.max(...panel.map(visibleWidth)));
    const x = Math.max(0, Math.floor((safeContentWidth - width) / 2));
    // Vertical constraints and comfortable ergonomic margins
    const maxAllowedY = totalRows - panelHeight;
    const topMargin = Math.max(1, Math.floor(totalRows * 0.05));
    const bottomMargin = Math.max(1, Math.min(3, Math.floor(totalRows * 0.10)));
    // Optical focal center of the transcript viewport (38% to 42% down reads as eye-level natural center)
    const opticalCenterY = Math.max(topMargin, Math.floor(maxAllowedY * 0.40));
    let targetY;
    if (options?.messageBounds) {
        const startRow = Number.isFinite(options.messageBounds.startRow) ? options.messageBounds.startRow : 0;
        const endRow = Number.isFinite(options.messageBounds.endRow) ? options.messageBounds.endRow : startRow;
        const msgTop = Math.max(0, Math.min(totalRows - 1, startRow));
        const msgBottom = Math.max(0, Math.min(totalRows - 1, endRow));
        const msgCenter = Math.floor((msgTop + msgBottom) / 2);
        // If message is near the bottom of viewport (bottom rows or starting below the max panel top):
        // Never squash the popup against the bottom composer! Float upward into the clear reading zone.
        if (msgBottom >= totalRows - 3 || msgTop >= maxAllowedY - 1) {
            if (msgTop >= panelHeight + topMargin) {
                // Float directly above the message if room permits, biased towards optical center
                const floatAbove = msgTop - panelHeight;
                targetY = Math.max(topMargin, Math.min(floatAbove, opticalCenterY + 2));
            }
            else {
                // Message spans the bottom or is tight: place at the viewport optical center
                targetY = opticalCenterY;
            }
        }
        else if (msgTop <= topMargin + 1) {
            // Message is at the very top: place with comfortable top margin
            targetY = Math.max(topMargin, Math.min(maxAllowedY - bottomMargin, msgCenter - Math.floor(panelHeight / 2)));
        }
        else {
            // Message is in the middle: center around message visual mass, softly blended with optical center
            const msgIdealY = msgCenter - Math.floor(panelHeight / 2);
            targetY = Math.round(0.75 * msgIdealY + 0.25 * opticalCenterY);
        }
    }
    else if (anchorY !== null && Number.isFinite(anchorY)) {
        const anchor = anchorY - safeStageTop;
        if (anchor >= totalRows - 2) {
            // Click at the extreme bottom edge: float upward into the reading zone
            targetY = Math.max(topMargin, Math.min(maxAllowedY - bottomMargin, opticalCenterY + 2));
        }
        else {
            // Standard anchor centering
            targetY = anchor - Math.floor(panelHeight / 2);
        }
    }
    else {
        targetY = opticalCenterY;
    }
    const y = Math.max(0, Math.min(maxAllowedY, Number.isFinite(targetY) ? targetY : opticalCenterY));
    const shouldDim = options?.dimBackdrop === true;
    const rows = viewportRows.slice();
    for (let r = 0; r < rows.length; r++) {
        const isPanelRow = r >= y && r < y + panelHeight;
        if (!isPanelRow) {
            if (shouldDim) {
                rows[r] = dimBackdropRow(rows[r] ?? '');
            }
            continue;
        }
        const panelIdx = r - y;
        const baseRow = rows[r] ?? '';
        const leftPrefix = padEnd(truncate(baseRow, x, ''), x);
        const cardChunk = padEnd(truncate(panel[panelIdx] ?? '', width, ''), width);
        const rightSuffix = sliceFromColumn(baseRow, x + width);
        const styledLeft = shouldDim ? dimBackdropRow(leftPrefix) : leftPrefix;
        const styledRight = shouldDim ? dimBackdropRow(rightSuffix) : rightSuffix;
        rows[r] = `${styledLeft}${cardChunk}${styledRight}`;
    }
    return { rows, layout: { x, y: safeStageTop + y, width, count: safeCount } };
}
