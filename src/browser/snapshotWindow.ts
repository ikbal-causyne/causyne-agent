// Adapted from camofox-browser's MIT-licensed snapshot windowing design.
// Copyright (c) 2025 Jo, Inc. See docs/THIRD_PARTY_NOTICES.md.

export const MAX_SNAPSHOT_CHARS = 80_000;
export const SNAPSHOT_TAIL_CHARS = 5_000;

export interface SnapshotWindow {
  text: string;
  truncated: boolean;
  totalChars: number;
  offset: number;
  hasMore: boolean;
  nextOffset: number | null;
}

export function windowSnapshot(snapshot: string, requestedOffset = 0): SnapshotWindow {
  const text = String(snapshot ?? '');
  const totalChars = text.length;
  if (totalChars <= MAX_SNAPSHOT_CHARS) {
    return { text, truncated: false, totalChars, offset: 0, hasMore: false, nextOffset: null };
  }

  const contentBudget = MAX_SNAPSHOT_CHARS - SNAPSHOT_TAIL_CHARS - 240;
  const maximumOffset = Math.max(0, totalChars - SNAPSHOT_TAIL_CHARS);
  const offset = Math.min(Math.max(0, Math.floor(requestedOffset)), maximumOffset);
  const chunkEnd = Math.min(offset + contentBudget, maximumOffset);
  const hasMore = chunkEnd < maximumOffset;
  const tail = text.slice(-SNAPSHOT_TAIL_CHARS);
  const marker = hasMore
    ? `\n[Snapshot truncated at character ${chunkEnd} of ${totalChars}. Request offset ${chunkEnd} for the next window.]\n`
    : '\n';
  return {
    text: text.slice(offset, chunkEnd) + marker + tail,
    truncated: true,
    totalChars,
    offset,
    hasMore,
    nextOffset: hasMore ? chunkEnd : null
  };
}
