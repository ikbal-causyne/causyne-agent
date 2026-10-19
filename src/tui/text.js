// ANSI-aware text primitives.
//
// Every one of these exists because the CLI got a terminal detail wrong:
//
//  * `padEnd` on a coloured string pads by BYTE length, so escape sequences
//    counted toward the column and every aligned table drifted.
//  * `slice()` on a coloured string can cut through the middle of an escape,
//    leaking `[38;2;96;205` as literal text and leaving the colour stuck on.
//  * Tool output was printed raw — see sanitize() below, which is a security
//    fix, not a cosmetic one.
//
// Pure JS. No dependency, no shell.

import os from 'os';

// CSI sequences (colour, cursor movement, erase) and OSC sequences (window
// title, hyperlinks — terminated by BEL or ST).
const CSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const OSC_PATTERN = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const OTHER_ESCAPE_PATTERN = /\x1b[@-Z\\-_]/g;

/** Everything that is an escape sequence rather than visible text. */
export function stripAnsi(text) {
  return String(text == null ? '' : text)
    .replace(OSC_PATTERN, '')
    .replace(CSI_PATTERN, '')
    .replace(OTHER_ESCAPE_PATTERN, '');
}

/**
 * Does this code point occupy two terminal columns?
 *
 * CJK, Hangul, Kana and most emoji are double-width. Getting this wrong is what
 * makes a table of Indonesian and Chinese filenames drift apart.
 */
function isWideCodePoint(code) {
  return (
    (code >= 0x1100 && code <= 0x115f) ||   // Hangul Jamo
    (code >= 0x2e80 && code <= 0xa4cf) ||   // CJK radicals … Yi
    (code >= 0xac00 && code <= 0xd7a3) ||   // Hangul syllables
    (code >= 0xf900 && code <= 0xfaff) ||   // CJK compatibility ideographs
    (code >= 0xfe30 && code <= 0xfe6f) ||   // CJK compatibility forms
    (code >= 0xff00 && code <= 0xff60) ||   // Fullwidth forms
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1f64f) || // emoji
    (code >= 0x1f900 && code <= 0x1f9ff)
  );
}

/**
 * The East Asian AMBIGUOUS class (UAX #11).
 *
 * These render as ONE column beside Latin text and TWO beside CJK, depending on
 * the terminal's font and locale — and every glyph in theme.js GLYPHS is in this
 * class: `·` U+00B7, `▸` U+25B8, `✓` U+2713, `─` U+2500, `│` U+2502, `…` U+2026.
 *
 * Counting them narrow is right for a Western-configured terminal and is what
 * every comparable library does, so that stays the default. But when the count
 * is wrong the row is WIDER than measured, the terminal wraps it, and a wrapped
 * row makes ChatPrompt.drawnRows (logical) disagree with the physical row count
 * — which is what left a doubled hint row and glyph debris on screen. Callers
 * that must not be wrong get the wide reading via the environment.
 */
function isAmbiguousCodePoint(code) {
  return (
    (code >= 0x00a1 && code <= 0x00ff && code !== 0x00ad) ||
    (code >= 0x2010 && code <= 0x2027) ||
    code === 0x2022 || code === 0x2026 ||
    (code >= 0x2190 && code <= 0x21ff) ||   // arrows
    (code >= 0x2200 && code <= 0x22ff) ||   // mathematical operators
    (code >= 0x2460 && code <= 0x24ff) ||   // enclosed alphanumerics
    (code >= 0x2500 && code <= 0x257f) ||   // box drawing
    (code >= 0x2580 && code <= 0x259f) ||   // block elements
    (code >= 0x25a0 && code <= 0x25ff) ||   // geometric shapes
    (code >= 0x2600 && code <= 0x26ff) ||   // miscellaneous symbols
    (code >= 0x2700 && code <= 0x27bf)      // dingbats (✓ ✕)
  );
}

/**
 * Should ambiguous-width code points be measured as two columns?
 *
 * Read once at import: an explicit override wins, otherwise a CJK locale is the
 * signal, because that is the configuration in which a terminal's font actually
 * renders these glyphs wide.
 */
function detectAmbiguousWide() {
  const explicit = process.env.CAUSYNE_AMBIGUOUS_WIDE;
  if (explicit === '1') return true;
  if (explicit === '0') return false;
  const locale = String(process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || '');
  return /^(ja|ko|zh)([_.-]|$)/i.test(locale);
}

export const AMBIGUOUS_IS_WIDE = detectAmbiguousWide();

/** Columns one code point occupies, under the active ambiguous-width policy. */
function columnsFor(code) {
  if (isWideCodePoint(code)) return 2;
  if (AMBIGUOUS_IS_WIDE && isAmbiguousCodePoint(code)) return 2;
  return 1;
}

/** Columns this string will occupy once printed. Escapes count for nothing. */
export function visibleWidth(text) {
  const plain = stripAnsi(text);
  let width = 0;
  for (const character of plain) {
    const code = character.codePointAt(0);
    if (code === 0x200d) continue;          // zero-width joiner
    if (code >= 0xfe00 && code <= 0xfe0f) continue; // variation selectors
    width += columnsFor(code);
  }
  return width;
}

const RESET = '\x1b[0m';

/**
 * Cut to `width` columns without ever splitting an escape sequence.
 *
 * Walks the string escape-aware rather than slicing by index, and closes any
 * style that was still open at the cut so the colour does not bleed into the
 * next line.
 */
export function truncate(text, width, ellipsis = '…') {
  const source = String(text == null ? '' : text);
  if (width <= 0) return '';
  if (visibleWidth(source) <= width) return source;

  const ellipsisWidth = visibleWidth(ellipsis);
  const budget = Math.max(0, width - ellipsisWidth);

  let out = '';
  let used = 0;
  let sawEscape = false;
  let index = 0;

  while (index < source.length) {
    if (source[index] === '\x1b') {
      // Copy the whole sequence verbatim; it costs no columns.
      const rest = source.slice(index);
      const match = rest.match(/^\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/)
        || rest.match(/^\x1b\[[0-?]*[ -/]*[@-~]/)
        || rest.match(/^\x1b[@-Z\\-_]/);
      if (match) {
        out += match[0];
        sawEscape = true;
        index += match[0].length;
        continue;
      }
    }

    const character = String.fromCodePoint(source.codePointAt(index));
    const charWidth = columnsFor(source.codePointAt(index));
    if (used + charWidth > budget) break;

    out += character;
    used += charWidth;
    index += character.length;
  }

  return out + (sawEscape ? RESET : '') + ellipsis;
}

/** Pad to an exact column count, measuring visible width rather than bytes. */
export function padEnd(text, width) {
  const gap = width - visibleWidth(text);
  return gap > 0 ? String(text) + ' '.repeat(gap) : String(text);
}


export function wrap(text, width) {
  if (width <= 0) return [String(text)];
  const lines = [];

  for (const paragraph of String(text == null ? '' : text).split('\n')) {
    if (visibleWidth(paragraph) <= width) {
      lines.push(paragraph);
      continue;
    }

    let current = '';
    for (const word of paragraph.split(' ')) {
      const candidate = current ? `${current} ${word}` : word;

      if (visibleWidth(candidate) <= width) {
        current = candidate;
        continue;
      }
      if (current) {
        lines.push(current);
        current = '';
      }

      let remainder = word;
      while (visibleWidth(remainder) > width) {
        lines.push(truncate(remainder, width, ''));
        // truncate() gives us the head; drop the same number of characters.
        let consumed = 0;
        let cut = 0;
        while (cut < remainder.length && consumed < width) {
          const code = remainder.codePointAt(cut);
          consumed += columnsFor(code);
          cut += String.fromCodePoint(code).length;
        }
        remainder = remainder.slice(cut);
      }
      current = remainder;
    }
    if (current) lines.push(current);
  }

  return lines;
}

/**
 * Word-wrap a block of text while preserving each line's own indentation.
 *
 * wrap() flattens indentation, which turns a nested list into a wall. This keeps
 * the leading whitespace a line already has and indents its continuation rows by
 * `hang` more, so a wrapped `/skills` entry still reads as one entry.
 *
 * Exists because command output was written to the terminal completely unwrapped
 * — a `/skills` description reached 195 columns on a 102-column terminal and the
 * terminal broke it at the right edge, mid-word, at column 0.
 */
export function wrapBlock(text, width, { hang = 2 } = {}) {
  const rows = [];
  for (const line of String(text == null ? '' : text).split('\n')) {
    const indent = (line.match(/^[ \t]*/) || [''])[0];
    const body = line.slice(indent.length);
    if (!body) { rows.push(''); continue; }

    const continuation = indent + ' '.repeat(hang);
    // Wrap at the NARROWER of the two budgets so neither the first row nor a
    // continuation row can exceed `width`.
    const budget = Math.max(8, width - visibleWidth(continuation));
    const parts = wrap(body, budget);
    rows.push(indent + parts[0]);
    for (const part of parts.slice(1)) rows.push(continuation + part);
  }
  return rows;
}

/**
 * Make untrusted text safe to print.
 *
 * SECURITY, not cosmetics. Tool output reaches the terminal directly: a file
 * read by fs_read, or the stdout of sysRun, is attacker-influenced content. If
 * it carries escape sequences it can move the cursor, erase the screen, or
 * overwrite lines that are already printed — including repainting an approval
 * prompt the user just answered. Stripping escapes is what makes "the user saw
 * what happened" true.
 *
 * Newlines and tabs survive; every other control character does not.
 */
/** Columns between terminal tab stops. Eight is the POSIX default everywhere. */
const TAB_WIDTH = 8;

/**
 * Replace tabs with the spaces the terminal would have moved over.
 *
 * A TAB MOVES THE CURSOR WITHOUT WRITING ANYTHING. In a live region that
 * redraws in place, that is not a formatting detail — it is corruption. The
 * cursor jumps over cells the previous frame wrote and leaves them on screen,
 * so `sw_vers` output rendered as:
 *
 *   ProductName:P_FIX_PLAN.mdmacOS
 *   ProductVersion:EGOTIATION26.5.2
 *
 * where `P_FIX_PLAN.md` and `EGOTIATION` are the tails of filenames printed by
 * the PREVIOUS command. Spaces overwrite; tabs do not.
 *
 * It also breaks measurement, which is worse. visibleWidth() counted a tab as
 * one column while the terminal advanced up to eight — on that line the error
 * was ten columns. A row the renderer believes fits therefore wraps, erase()
 * miscounts how many rows to walk back, and it eats real conversation above the
 * prompt. That is the live-region width invariant, broken by one byte.
 *
 * Tab stops are per LINE and reset after every newline, so this tracks the
 * column rather than substituting a fixed run of spaces — which is what keeps
 * columnar output actually lining up.
 */
export function expandTabs(text, tabWidth = TAB_WIDTH) {
  const source = String(text == null ? '' : text);
  if (!source.includes('\t')) return source;

  let out = '';
  let column = 0;
  for (const char of source) {
    if (char === '\t') {
      const advance = tabWidth - (column % tabWidth);
      out += ' '.repeat(advance);
      column += advance;
    } else if (char === '\n') {
      out += char;
      column = 0;
    } else {
      out += char;
      column += 1;
    }
  }
  return out;
}

export function sanitize(text) {
  // Tabs are expanded rather than stripped: removing them would collapse
  // columnar output into an unreadable run, and leaving them corrupts the
  // frame. Expansion is the only option that preserves what the user meant to
  // see. Everything else in this class is genuinely unwanted and is removed.
  return expandTabs(stripAnsi(text))
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

/** `/Users/example/Projects/x` → `~/Projects/x`. Long paths dominate a tool row. */
export function shortenHome(value) {
  const home = os.homedir();
  const text = String(value == null ? '' : value);
  if (home && text.startsWith(home)) return '~' + text.slice(home.length);
  return text;
}


const SECRET_PATTERNS = [
  [/\b(sk|pk|rk)-[A-Za-z0-9_-]{12,}/g, (m) => `${m.slice(0, 5)}…${m.slice(-4)}`],
  [/\b(gh[pousr]|xox[baprs])_[A-Za-z0-9]{12,}/g, (m) => `${m.slice(0, 7)}…`],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, (m) => `${m.split(/\s+/)[0]} …`],
  [/\b(api[_-]?key|token|secret|password|passwd)\s*[=:]\s*["']?[^\s"']{6,}/gi,
    (m) => `${m.split(/[=:]/)[0]}=…`]
];

export function redactSecrets(text) {
  let out = String(text == null ? '' : text);
  for (const [pattern, replace] of SECRET_PATTERNS) {
    out = out.replace(pattern, replace);
  }
  return out;
}

/** sanitize + redact — the pipeline every untrusted string goes through. */
export function safeDisplay(text) {
  return redactSecrets(sanitize(text));
}
