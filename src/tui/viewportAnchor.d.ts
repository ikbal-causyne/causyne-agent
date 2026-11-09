export interface ReadingMarker { id?: number; row: number; kind?: string }
export interface ReadingAnchor {
  readonly id: number | null;
  readonly index: number;
  readonly offset: number;
  readonly fraction: number;
  readonly originalTop: number;
}
export declare function captureReadingAnchor(
  markers: ReadingMarker[] | null | undefined,
  top: number,
  totalHeight: number
): ReadingAnchor | null;
export declare function restoreReadingAnchor(
  anchor: ReadingAnchor | null,
  markers: ReadingMarker[] | null | undefined,
  totalHeight: number,
  viewportHeight: number
): number;
