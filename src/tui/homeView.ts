import { sessionBanner, type BannerInfo } from './banner.js';
import { centerRows } from './layout.js';
import { fitHomeContent } from './composerGeometry.js';
import { panelRows } from './overlay.js';

export interface PlacedView {
  rows: string[];
  caretRow: number;
  caretCol: number;
}

interface StartupSurface {
  homeInfo?: unknown;
  transcript?: { frames?: Array<{ kind?: string }> };
}

interface StartupLayer {
  title?: string;
  footer?: string;
  width?: number;
  cursor?: { x: number; y: number } | null;
  preferredHeight(): number;
  body(width: number, height: number): string[];
}

/** A modal before the first conversation belongs to the centered home view. */
export function isStartupDialog(surface: StartupSurface | null | undefined): boolean {
  if (!surface) return false;
  if (surface.homeInfo) return true;
  return !surface.transcript?.frames?.some(frame => frame.kind === 'user' || frame.kind === 'assistant');
}

/** Keep startup pickers readable without letting a long catalogue resize the UI. */
export function startupDialogView(layer: StartupLayer, columns: number, terminalRows: number): PlacedView {
  const availableWidth = Number.isFinite(columns) ? Math.max(8, Math.floor(columns) - 1) : 79;
  const availableHeight = Number.isFinite(terminalRows) ? Math.max(4, Math.floor(terminalRows) - 2) : 20;
  const width = Math.min(availableWidth, 96, Math.max(88, Math.floor(layer.width || 0)));
  const height = Math.min(availableHeight, 30);
  const measuredLayer = {
    title: layer.title,
    footer: layer.footer,
    preferredHeight: () => Math.max(10, layer.preferredHeight()),
    body: (innerWidth: number, bodyHeight: number) => layer.body(innerWidth, bodyHeight)
  };
  const centered = centerRows(panelRows(measuredLayer, width, height) as string[], columns);
  const cursor = layer.cursor;
  return {
    rows: centered.rows,
    caretRow: cursor ? 1 + cursor.y : 0,
    caretCol: centered.inset + (cursor ? 2 + cursor.x : 0)
  };
}

/** Center a temporary dialog in the available terminal region. */
export function placeDialog(rows: string[], columns: number, height: number, caretRow: number, caretCol: number): PlacedView {
  const safeHeight = Number.isFinite(height) ? height : 1;
  const safeColumns = Number.isFinite(columns) ? columns : 2;
  const safeCaretRow = Number.isFinite(caretRow) ? caretRow : 0;
  const safeCaretCol = Number.isFinite(caretCol) ? caretCol : 0;
  const available = Math.max(1, Math.floor(safeHeight));
  const shown = rows.slice(0, available);
  const top = Math.max(0, Math.floor((available - shown.length) / 2));
  return {
    rows: [...Array<string>(top).fill(''), ...shown],
    caretRow: top + Math.max(0, Math.min(safeCaretRow, shown.length - 1)),
    caretCol: Math.max(0, Math.min(safeCaretCol, safeColumns - 2))
  };
}

/** A clean first screen; session messages are intentionally absent. */
export function placeHome(
  info: BannerInfo,
  promptRows: string[],
  columns: number,
  height: number,
  caretRow: number,
  caretCol: number
): PlacedView {
  const safeColumns = Number.isFinite(columns) ? Math.max(1, Math.floor(columns)) : 80;
  const available = Number.isFinite(height) ? Math.max(1, Math.floor(height)) : 24;
  const safeCaretRow = Number.isFinite(caretRow) ? Math.floor(caretRow) : 0;
  const safeCaretCol = Number.isFinite(caretCol) ? Math.floor(caretCol) : 0;
  const logo = centerRows(sessionBanner(info, safeColumns, { height: available }), safeColumns).rows;
  const spacer = available >= 25 ? 2 : 1;
  // When the window is short, preserve the composer and editing caret first.
  // The logo yields height; it must never push a wrapped draft off-screen.
  const fitted = fitHomeContent(logo, promptRows, available, safeCaretRow, spacer);
  const required = fitted.logoRows.length + fitted.spacer + fitted.promptRows.length;
  const top = Math.max(0, Math.floor((available - required) / 2));
  const rows = [
    ...Array<string>(top).fill(''),
    ...fitted.logoRows,
    ...Array<string>(fitted.spacer).fill(''),
    ...fitted.promptRows
  ];
  return {
    rows,
    caretRow: top + fitted.logoRows.length + fitted.spacer + fitted.caretRow,
    caretCol: Math.max(0, Math.min(safeCaretCol, safeColumns - 2))
  };
}
