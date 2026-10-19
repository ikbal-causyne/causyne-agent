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
//
// Pure Node over ./theme.js and ./text.js. No dependency, no shell.

import { paint, fill, dim, GLYPHS, HAS_COLOR } from './theme.js';
import { visibleWidth, padEnd, truncate, wrap } from './text.js';

// Columns between the bar and the text. opencode uses paddingLeft={2} inside its
// bordered box; one column belongs to the bar, so the gutter is one more.
const GUTTER = 1;

/**
 * Render `lines` as one block with a left accent bar.
 *
 * @param {string[]} lines    already-styled rows; NOT re-wrapped (see blockOf)
 * @param {object}   options
 * @param {number}   options.width   total columns the block may occupy
 * @param {string}   options.role    accent role for the bar (user, agent, accent…)
 * @param {boolean}  options.filled  paint the surface behind the text
 * @param {string}   options.surface which surface role to fill with
 * @returns {string[]} rows, each exactly `width` columns wide
 */
export function barBlock(lines, {
  width = 80,
  role = 'accent',
  filled = true,
  surface = 'surface',
  punctuate = false
} = {}) {
  // The input box asks for a continuous heavy rule with a dot at its middle —
  // long line, dot, long line. Everything else keeps the half-block bar, because
  // a message block is content and the input box is chrome you type INTO; the
  // reference draws that distinction too, giving its prompt box custom border
  // characters no message uses (component/prompt/index.tsx:1354-1358).
  //
  // Punctuation needs three rows to read as "middle": below that it would land
  // on the only row there is, and a dot alone is not a rule.
  const glyph = punctuate ? GLYPHS.barHeavy : GLYPHS.bar;
  const middle = punctuate && lines.length >= 3 ? Math.floor(lines.length / 2) : -1;

  const barWidth = visibleWidth(glyph);
  const body = Math.max(1, width - barWidth - GUTTER);
  const bar = paint(role, glyph);
  const marked = paint(role, GLYPHS.bullet);
  const gutter = ' '.repeat(GUTTER);

  return lines.map((line, index) => {
    // Clip first, then pad: a line longer than the block would otherwise push
    // the fill past the right edge and wrap, which is the failure ChatPrompt
    // clampRows() exists to prevent one layer up.
    const clipped = visibleWidth(line) > body ? truncate(line, body, GLYPHS.ellipsis) : line;
    const padded = padEnd(clipped, body);
    const inner = filled ? fill(surface, gutter + padded) : gutter + padded;
    return (index === middle ? marked : bar) + inner;
  });
}

/**
 * Wrap `text` to the block's inner width, then render it as a block.
 *
 * The convenience form for plain prose. Callers that have already styled their
 * rows individually (the prompt editor, a status row) use barBlock directly.
 */
export function blockOf(text, options = {}) {
  const width = options.width || 80;
  const inner = Math.max(1, width - visibleWidth(GLYPHS.bar) - GUTTER);
  const lines = wrap(String(text == null ? '' : text), inner);
  return barBlock(lines.length ? lines : [''], options);
}

/**
 * A bordered panel with its title inset into the top border.
 *
 * The session header used to be two horizontal rules with label/value rows
 * between them, which reads as a table of settings rather than as a greeting.
 * Both references open with a bordered panel instead — claude-code insets the
 * product name and version into the top rule exactly this way.
 *
 * `rows` are already-styled strings. Returns rows of exactly `width` columns.
 */
export function panel(rows, { width = 80, title = '', role = 'rule' } = {}) {
  const inner = Math.max(4, width - 2);
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
 *
 * Returns '' rather than a misleading 0% when no limit is known: an invented
 * denominator is worse than a missing number.
 *
 * BOTH ARGUMENTS MUST BE IN THE SAME UNIT. The caller was passing a cumulative
 * TOKEN count and a CHARACTER pool, which is how a quarter-full window came to
 * report 99%.
 */
export function contextMeter(usedTokens, limitTokens) {
  const used = Number(usedTokens) || 0;
  const limit = Number(limitTokens) || 0;
  if (used <= 0) return '';
  const compact = used < 1000
    ? String(Math.round(used))
    : used < 1000000
      ? `${(used / 1000).toFixed(used < 10000 ? 1 : 0)}K`
      : `${(used / 1000000).toFixed(1)}M`;
  if (limit <= 0) return compact;
  // NOT clamped to 99. The clamp was there to keep the meter from looking like
  // a hard stop, and its real effect was to hide a 242% reading behind a
  // plausible-looking one for a whole session. A meter that cannot report
  // "over" is a meter that cannot report the only thing worth acting on.
  return `${compact} (${Math.round((used / limit) * 100)}%)`;
}

export { GUTTER };
