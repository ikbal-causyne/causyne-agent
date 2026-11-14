function clampedRows(value: number, limit: number): number {
  if (value === Number.POSITIVE_INFINITY) return limit;
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

/** Keep an opened conversation anchored to the terminal bottom at every width. */
export function sessionStageHeight(maxHeight: number, promptRows: number, contentRows: number, fullSession: boolean): number {
  const limit = Number.isFinite(maxHeight) ? Math.max(1, Math.floor(maxHeight)) : 1;
  const total = clampedRows(promptRows, limit) + clampedRows(contentRows, limit);
  return fullSession ? limit : Math.min(limit, Math.max(1, total));
}

/** Place a short transcript beside the input; spare space belongs above it. */
export function alignTranscriptRows(rows: string[], contentRows: number): string[] {
  const visible = Math.min(rows.length, clampedRows(contentRows, rows.length));
  if (visible === rows.length) return rows;
  return Array<string>(rows.length - visible).fill('').concat(rows.slice(0, visible));
}
