/**
 * Causyne composer geometry. This module owns column arithmetic, never I/O.
 *
 * `barBlock` consumes the left bar + gutter. A painted block is exactly
 * `boxWidth` cells, but the editing surface must reserve a caret cell so a
 * full row cannot position the terminal cursor in the clipped right margin.
 */
export interface ComposerGeometry {
  boxWidth: number;
  inset: number;
  bodyWidth: number;
  editorWidth: number;
  maxCaretCol: number;
}

export function composerGeometry(
  requestedWidth: number,
  barColumns: number,
  gutterColumns: number
): ComposerGeometry {
  const width = Number.isFinite(requestedWidth)
    ? Math.max(4, Math.trunc(requestedWidth))
    : 80;
  const boxWidth = width - 1; // never occupy the terminal's deferred-wrap cell
  const glyph = Number.isFinite(barColumns) ? Math.max(0, Math.trunc(barColumns)) : 1;
  const gutter = Number.isFinite(gutterColumns) ? Math.max(0, Math.trunc(gutterColumns)) : 1;
  const inset = Math.min(glyph + gutter, Math.max(0, boxWidth - 2));
  const bodyWidth = Math.max(1, boxWidth - inset);
  const editorWidth = Math.max(1, bodyWidth - 1); // reserve a full cursor cell
  return { boxWidth, inset, bodyWidth, editorWidth, maxCaretCol: boxWidth - 1 };
}

export interface FittedHomeContent {
  /** Full banner, or none when the terminal cannot show it without clipping. */
  logoRows: string[];
  /** Composer rows kept as a contiguous window around the editing caret. */
  promptRows: string[];
  spacer: number;
  caretRow: number;
}

/**
 * In a small terminal the editor is more important than the full brand banner.
 * This helper never loses the caret or returns more rows than the Stage owns.
 * The ordinary roomy Home composition is unchanged.
 */
export function fitHomeContent(
  logoRows: readonly string[],
  promptRows: readonly string[],
  stageHeight: number,
  caretRow: number,
  requestedSpacer: number
): FittedHomeContent {
  const available = Number.isFinite(stageHeight)
    ? Math.max(1, Math.trunc(stageHeight))
    : 24;
  const prompt = promptRows.length ? [...promptRows] : [''];
  const caret = Number.isFinite(caretRow)
    ? Math.max(0, Math.min(prompt.length - 1, Math.trunc(caretRow)))
    : 0;
  const promptCount = Math.min(available, prompt.length);
  const start = prompt.length > available
    ? Math.min(Math.max(0, caret - Math.floor(available / 2)), prompt.length - available)
    : 0;
  const visiblePrompt = prompt.slice(start, start + promptCount);
  const remaining = available - visiblePrompt.length;
  // A cropped rotor/wordmark looks broken. On cramped terminals, hide the
  // banner as a whole rather than displaying an arbitrary bottom fragment.
  const showLogo = logoRows.length > 0 && remaining >= logoRows.length;
  const visibleLogo = showLogo ? [...logoRows] : [];
  const spacer = showLogo
    ? Math.min(Math.max(0, Number.isFinite(requestedSpacer) ? Math.trunc(requestedSpacer) : 0), remaining - logoRows.length)
    : 0;
  return {
    logoRows: visibleLogo,
    promptRows: visiblePrompt,
    spacer,
    caretRow: Math.max(0, Math.min(visiblePrompt.length - 1, caret - start))
  };
}
