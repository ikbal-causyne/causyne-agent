/**
 * Preserve the reader's location while terminal geometry changes.
 *
 * Row indices are screen-layout positions, not document positions. Re-wrapping a
 * transcript changes frame heights, so keeping the same numeric scrollTop can
 * jump to unrelated content. Frame identity + relative offset is stable across
 * width changes, without storing or duplicating any message content.
 *
 * This module is deliberately independent of Stage, Transcript, and Node I/O.
 */

function finiteRow(value) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function safeMarkers(markers) {
  if (!Array.isArray(markers)) return [];
  return markers
    .filter(marker => marker && Number.isFinite(marker.row) && marker.row >= 0)
    .map((marker, index) => ({
      id: marker.id,
      row: finiteRow(marker.row),
      originalIndex: index
    }));
}

/** Capture an anchor at the first visible row, measured within its frame. */
export function captureReadingAnchor(markers, top, totalHeight) {
  const entries = safeMarkers(markers);
  if (!entries.length) return null;
  const row = finiteRow(top);
  let selected = 0;
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].row > row) break;
    selected = i;
  }
  const start = entries[selected].row;
  const next = entries[selected + 1]?.row ?? finiteRow(totalHeight);
  const frameLength = Math.max(1, next - start);
  return Object.freeze({
    id: entries[selected].id ?? null,
    index: entries[selected].originalIndex,
    offset: Math.max(0, row - start),
    fraction: Math.max(0, Math.min(1, (row - start) / frameLength)),
    originalTop: row
  });
}

/** Restore to the corresponding frame and approximately the same content line. */
export function restoreReadingAnchor(anchor, markers, totalHeight, viewportHeight) {
  const total = finiteRow(totalHeight);
  const visible = Math.max(1, finiteRow(viewportHeight));
  const max = Math.max(0, total - visible);
  if (!anchor || !max) return 0;
  const entries = safeMarkers(markers);
  if (!entries.length) return Math.min(max, finiteRow(anchor.originalTop));

  let selected = anchor.id == null
    ? -1
    : entries.findIndex(marker => marker.id === anchor.id);
  if (selected < 0 && anchor.id == null && entries[anchor.index]?.originalIndex === anchor.index) {
    selected = anchor.index;
  }
  if (selected < 0) {
    // Frames may have been evicted while the user was reading. Use the first
    // surviving frame rather than silently jumping to an unrelated old row.
    selected = 0;
  }
  const start = entries[selected].row;
  const end = entries[selected + 1]?.row ?? total;
  const length = Math.max(1, end - start);
  const fraction = Number.isFinite(anchor.fraction) ? Math.max(0, Math.min(1, anchor.fraction)) : 0;
  // Relative position is more useful than raw offset after a long paragraph
  // wraps from 15 lines to 30, while staying inside the same frame.
  const offset = Math.min(length - 1, Math.round(fraction * length));
  return Math.max(0, Math.min(max, start + offset));
}
