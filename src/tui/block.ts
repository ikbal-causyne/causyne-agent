// Blocks: a left accent bar and a filled surface, the shape that makes a run of
// terminal rows read as ONE thing.
//
// Causyne's chat printed every kind of row the same way — the user's message, the
// agent's reply, an aside from the loop and the prompt itself were all just
// lines in the scrollback, distinguishable only by a leading glyph. On a busy
// turn there was no visual seam anywhere, which is the difference the reference
// tools actually make. opencode gives each of those a left border in the agent's
// colour and a background one step off the terminal's own
// (component/prompt/index.tsx:1353 — `border={["left"]}` + `borderColor` +
// `backgroundColor={theme.backgroundElement}` + `paddingLeft={2}`).
//
// Two properties make it work, and both are easy to get wrong:
//
//  * EVERY ROW IS PADDED TO THE SAME WIDTH. A background only reads as a surface
//    if it runs past the last character; ragged rows read as highlighted text.
//  * THE PADDING IS MEASURED, NOT COUNTED. padEnd() on a coloured string pads by
//    byte length, so the escape sequences count toward the column and the right
//    edge of the block frays. text.js padEnd() measures visible width.
//
// It degrades in two steps rather than one: without truecolor/256 there is no
// fill and the bar alone carries the block; without colour at all the bar is an
// ASCII `|`. A transcript piped to a file stays clean either way.

// @ts-expect-error theme.js has no TypeScript declaration yet.
import { paint, fill, dim, GLYPHS, HAS_COLOR } from './theme.js';
import { visibleWidth, padEnd, truncate, wrap } from './text.js';

// Columns between the bar and the text. opencode uses paddingLeft={2} inside its
// bordered box; one column belongs to the bar, so the gutter is one more.
const GUTTER = 1;

function finiteWidth(width: number | undefined, fallback = 80): number {
  return typeof width === 'number' && Number.isFinite(width) ? Math.floor(width) : fallback;
}

export interface BarBlockOptions {
  width?: number;
  role?: string;
  filled?: boolean;
  surface?: string;
  punctuate?: boolean;
}

/**
 * Render `lines` as one block with a left accent bar.
 * Uses a continuous unbroken box-drawing heavy rule (barHeavy '┃')
 * that dynamically spans the exact length of lines without gaps or bullet interruptions.
 *
 * @param lines already-styled rows; NOT re-wrapped (see blockOf)
 * @param options configuration options
 * @returns rows, each exactly `width` columns wide
 */
export function barBlock(lines: string[], {
  width = 80,
  role = 'accent',
  filled = true,
  surface = 'surface',
  punctuate = false
}: BarBlockOptions = {}): string[] {
  // Use continuous heavy vertical line ('┃') for clean, solid, unbroken alignment.
  // Box-drawing characters connect seamlessly across lines in all terminal fonts without line-height leading gaps.
  const glyph = GLYPHS.barHeavy || GLYPHS.bar || '┃';

  const barWidth = visibleWidth(glyph);
  const body = Math.max(1, finiteWidth(width) - barWidth - GUTTER);
  const bar = paint(role, glyph);
  const gutter = ' '.repeat(GUTTER);

  return lines.map((line) => {
    // Clip first, then pad: a line longer than the block would otherwise push
    // the fill past the right edge and wrap, which is the failure ChatPrompt
    // clampRows() exists to prevent one layer up.
    const clipped = visibleWidth(line) > body ? truncate(line, body, GLYPHS.ellipsis) : line;
    const padded = padEnd(clipped, body);
    const inner = filled ? fill(surface, gutter + padded) : gutter + padded;
    return bar + inner;
  });
}

/**
 * Wrap `text` to the block's inner width, then render it as a block.
 *
 * The convenience form for plain prose. Callers that have already styled their
 * rows individually (the prompt editor, a status row) use barBlock directly.
 */
export function blockOf(text: string, options: BarBlockOptions = {}): string[] {
  const safeWidth = finiteWidth(options.width) || 80;
  const glyph = GLYPHS.barHeavy || GLYPHS.bar || '┃';
  const inner = Math.max(1, safeWidth - visibleWidth(glyph) - GUTTER);
  const lines = wrap(String(text == null ? '' : text), inner);
  return barBlock(lines.length ? lines : [''], { ...options, width: safeWidth });
}

export interface PanelOptions {
  width?: number;
  title?: string;
  role?: string;
}

/**
 * A bordered panel with its title inset into the top border.
 */
export function panel(rows: string[], { width = 80, title = '', role = 'rule' }: PanelOptions = {}): string[] {
  const inner = Math.max(4, finiteWidth(width) - 2);
  const h = GLYPHS.hLine;
  const label = title ? ` ${title} ` : '';
  const clippedLabel = visibleWidth(label) > inner - 2 ? '' : label;
  const lead = clippedLabel ? h : '';
  const trail = h.repeat(Math.max(0, inner - visibleWidth(clippedLabel) - visibleWidth(lead)));

  const top = paint(role, GLYPHS.topLeft + lead)
    + (clippedLabel ? paint('accent', clippedLabel) : '')
    + paint(role, trail + GLYPHS.topRight);
  const bottom = paint(role, GLYPHS.bottomLeft + h.repeat(inner) + GLYPHS.bottomRight);

  const side = paint(role, GLYPHS.vLine);
  const middle = rows.map((row) => {
    const clipped = visibleWidth(row) > inner ? truncate(row, inner, GLYPHS.ellipsis) : row;
    return side + padEnd(clipped, inner) + side;
  });

  return [top, ...middle, bottom];
}

/**
 * `9.2K (5%)` — what the context window has left, at a glance.
 */
export function contextMeter(usedTokens: number, limitTokens: number): string {
  const rawUsed = Number(usedTokens);
  const rawLimit = Number(limitTokens);
  const used = Number.isFinite(rawUsed) ? rawUsed : 0;
  const limit = Number.isFinite(rawLimit) ? rawLimit : 0;
  if (used <= 0) return '';
  const compact = used < 1000
    ? String(Math.round(used))
    : used < 1000000
      ? `${(used / 1000).toFixed(used < 10000 ? 1 : 0)}K`
      : `${(used / 1000000).toFixed(1)}M`;
  if (limit <= 0) return compact;
  return `${compact} (${Math.round((used / limit) * 100)}%)`;
}

export { GUTTER };

