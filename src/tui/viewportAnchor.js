/**
 * Frame-anchored viewport reflow for Causyne's Stage/Transcript architecture.
 *
 * Numeric scroll rows are layout coordinates. They change when a terminal is
 * resized, whereas a transcript frame's ID remains stable. Preserve the frame
 * identity and the approximate relative reading position within that frame.
 *
 * TypeScript is the authoritative source. Runtime JS is produced by the
 * repository's existing `tsc -p tsconfig.runtime.json` build.
 */
function finiteRow(value) {
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}
function safeMarkers(markers) {
    if (!Array.isArray(markers))
        return [];
    return markers.flatMap((marker, originalIndex) => {
        if (!marker || !Number.isFinite(marker.row) || marker.row < 0)
            return [];
        return [{ id: marker.id, row: finiteRow(marker.row), originalIndex }];
    });
}
/** Capture the first currently visible frame and relative position within it. */
export function captureReadingAnchor(markers, top, totalHeight) {
    const entries = safeMarkers(markers);
    if (entries.length === 0)
        return null;
    const row = finiteRow(top);
    let selected = 0;
    for (let i = 0; i < entries.length; i++) {
        if ((entries[i]?.row ?? Number.POSITIVE_INFINITY) > row)
            break;
        selected = i;
    }
    const entry = entries[selected];
    if (!entry)
        return null;
    const start = entry.row;
    const next = entries[selected + 1]?.row ?? finiteRow(totalHeight);
    const frameLength = Math.max(1, next - start);
    return Object.freeze({
        id: entry.id ?? null,
        index: entry.originalIndex,
        offset: Math.max(0, row - start),
        fraction: Math.max(0, Math.min(1, (row - start) / frameLength)),
        originalTop: row
    });
}
/** Restore the matching frame and a proportional content offset after reflow. */
export function restoreReadingAnchor(anchor, markers, totalHeight, viewportHeight) {
    const total = finiteRow(totalHeight);
    const visible = Math.max(1, finiteRow(viewportHeight));
    const max = Math.max(0, total - visible);
    if (!anchor || max === 0)
        return 0;
    const entries = safeMarkers(markers);
    if (entries.length === 0)
        return Math.min(max, finiteRow(anchor.originalTop));
    let selected = anchor.id == null
        ? -1
        : entries.findIndex(marker => marker.id === anchor.id);
    if (selected < 0 && anchor.id == null && entries[anchor.index]?.originalIndex === anchor.index) {
        selected = anchor.index;
    }
    if (selected < 0) {
        // When the anchored frame was evicted, recover in the surviving transcript.
        selected = 0;
    }
    const entry = entries[selected];
    if (!entry)
        return Math.min(max, finiteRow(anchor.originalTop));
    const start = entry.row;
    const end = entries[selected + 1]?.row ?? total;
    const length = Math.max(1, end - start);
    const fraction = Number.isFinite(anchor.fraction)
        ? Math.max(0, Math.min(1, anchor.fraction))
        : 0;
    const offset = Math.min(length - 1, Math.round(fraction * length));
    return Math.max(0, Math.min(max, start + offset));
}
