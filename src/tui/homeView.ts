import { sessionBanner, type BannerInfo } from './banner.js';
import { centerRows } from './layout.js';

export interface PlacedView {
  rows: string[];
  caretRow: number;
  caretCol: number;
}

/** Center a temporary dialog in the available terminal region. */
export function placeDialog(rows: string[], columns: number, height: number, caretRow: number, caretCol: number): PlacedView {
  const available = Math.max(1, Math.floor(height));
  const shown = rows.slice(0, available);
  const top = Math.max(0, Math.floor((available - shown.length) / 2));
  return {
    rows: [...Array<string>(top).fill(''), ...shown],
    caretRow: top + Math.min(Math.max(0, caretRow), shown.length - 1),
    caretCol: Math.max(0, Math.min(caretCol, columns - 2))
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
  const available = Math.max(1, Math.floor(height));
  const logo = centerRows(sessionBanner(info, columns, { height: available }), columns).rows;
  const spacer = available >= 25 ? 2 : 1;
  const required = logo.length + spacer + promptRows.length;
  const top = Math.max(0, Math.floor((available - required) / 2));
  const rows = [
    ...Array<string>(top).fill(''),
    ...logo,
    ...Array<string>(spacer).fill(''),
    ...promptRows
  ];
  return {
    rows: rows.slice(0, available),
    caretRow: Math.min(available - 1, top + logo.length + spacer + Math.max(0, caretRow)),
    caretCol: Math.max(0, Math.min(caretCol, columns - 2))
  };
}
