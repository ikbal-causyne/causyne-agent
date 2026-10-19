// Terminal theme — colour that adapts instead of assuming.
//
// The CLI used hardcoded \x1b[36m-style escapes everywhere. That assumes a dark
// background, assumes colour is wanted, and assumes the terminal supports it.
// On a light terminal the "muted grey" comments were nearly invisible; piped
// into a file or a CI log, every line carried escape bytes.
//
// This module answers three questions once, at import: may we colour at all,
// how many colours, and is the background light or dark. Everything else in the
// TUI asks for a SEMANTIC role (accent, danger, muted) and gets whatever that
// resolves to here.
//
// Pure Node: no dependency, no shell. Readable by construction.

import os from 'os';

// ---------------------------------------------------------------------------
// Capability detection
// ---------------------------------------------------------------------------

function detectColorSupport() {
  // https://no-color.org — an explicit user opt-out beats every heuristic.
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== '') return 0;
  if (process.env.CAUSYNE_NO_COLOR === '1') return 0;

  const forced = process.env.FORCE_COLOR;
  if (forced === '0') return 0;
  if (forced === '1') return 16;
  if (forced === '2') return 256;
  if (forced === '3') return 16777216;

  // Not a terminal: piped to a file, a pager or a CI log. Escapes there are
  // noise at best and corrupt parsing at worst.
  if (!process.stdout.isTTY) return 0;
  if (process.env.TERM === 'dumb') return 0;

  const colorterm = String(process.env.COLORTERM || '').toLowerCase();
  if (colorterm === 'truecolor' || colorterm === '24bit') return 16777216;

  const term = String(process.env.TERM || '');
  if (/-256(color)?$/i.test(term)) return 256;
  if (/^(screen|xterm|vt100|vt220|rxvt|color|ansi|cygwin|linux)/i.test(term)) return 16;

  // Windows Terminal and modern conhost handle truecolor; older ones do not.
  if (os.platform() === 'win32') return 256;
  return 16;
}

/**
 * Is the terminal background light?
 *
 * COLORFGBG is set by several terminals as "foreground;background" in xterm
 * palette indices. It is the only broadly available signal that does not
 * require querying the terminal and parsing an escape reply, which would mean
 * writing to stdout during startup.
 */
function detectLightBackground() {
  const explicit = String(process.env.CAUSYNE_THEME || '').toLowerCase();
  if (explicit === 'light') return true;
  if (explicit === 'dark') return false;

  const colorfgbg = process.env.COLORFGBG;
  if (colorfgbg && colorfgbg.length <= 64) {
    const parts = colorfgbg.split(';');
    const background = parseInt(parts[parts.length - 1], 10);
    if (Number.isFinite(background)) {
      // 7 and 15 are the light greys/white of the base 16; 232-255 is the
      // greyscale ramp, where the upper half reads as a light background.
      if (background <= 15) return background === 7 || background === 15;
      if (background >= 232) return background >= 244;
    }
  }
  return false; // dark is the safer default: most developer terminals are dark
}

export const COLOR_DEPTH = detectColorSupport();
export const IS_LIGHT = detectLightBackground();
export const HAS_COLOR = COLOR_DEPTH > 0;

// Unicode box drawing is not safe everywhere — Windows code pages and some CI
// runners mangle it. One flag decides, so every renderer stays consistent.
export const HAS_UNICODE = HAS_COLOR
  && process.env.CAUSYNE_ASCII !== '1'
  && (os.platform() !== 'win32' || Boolean(process.env.WT_SESSION));

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

// Roles, not colours. A caller asking for `danger` should never care whether
// that is truecolor crimson or plain ANSI red.
const DARK_PALETTE = {
  accent:  [ 96, 205, 255],
  agent:   [138, 180, 248],
  user:    [ 90, 200, 160],
  success: [126, 199, 108],
  warn:    [230, 190,  90],
  danger:  [235, 110, 110],
  muted:   [130, 138, 150],
  ink:     [225, 228, 234],
  rule:    [ 62,  68,  80],
  // The scroll rail. A deliberately DARK blue, not the accent.
  //
  // The rail is orientation, not information you act on — it says where you are
  // while you read something else, so it must be legible without competing with
  // the transcript for attention. In `accent` cyan it was the brightest thing on
  // a screen full of prose. Dark enough to recede, blue enough to read as one
  // continuous object beside the markers, which keep their own roles.
  scroll:  [ 58, 110, 170],
  // Background roles. opencode fills its input surface with theme
  // backgroundElement and marks it with a left border in the agent's colour
  // (component/prompt/index.tsx: border={["left"]} + backgroundColor). These are
  // that fill: one step off the terminal's own background, never a block of
  // colour that fights the text sitting on it.
  surface:  [ 28,  31,  38],
  surfaceHi:[ 38,  42,  51]
};

const LIGHT_PALETTE = {
  accent:  [  0, 110, 170],
  agent:   [ 40,  80, 170],
  user:    [ 20, 120,  90],
  success: [ 30, 120,  40],
  warn:    [155, 110,   0],
  danger:  [185,  40,  40],
  muted:   [ 95, 102, 112],
  ink:     [ 25,  28,  34],
  rule:    [200, 204, 212],
  scroll:  [ 60, 100, 160],
  surface:  [242, 244, 247],
  surfaceHi:[232, 235, 240]
};

// Fallback for 16-colour terminals: the closest base ANSI code per role.
const BASIC_CODES = {
  accent: 36, agent: 34, user: 32, success: 32,
  warn: 33, danger: 31, muted: 90, ink: 39, rule: 90,
  scroll: 34,
  surface: 39, surfaceHi: 39
};

// Background codes for the 16-colour fallback. A base-16 terminal has no shade
// between "black" and "bright black", so a surface fill there would be a slab of
// solid grey behind the text — worse than no fill. It gets none, and the left
// bar alone carries the block. See fill().
const BASIC_BG_CODES = { surface: 0, surfaceHi: 100 };

const PALETTE = IS_LIGHT ? LIGHT_PALETTE : DARK_PALETTE;

function rgbTo256(r, g, b) {
  // Greyscale ramp first — it is far more accurate for the muted/rule roles
  // than the 6×6×6 cube, which has coarse steps near grey.
  if (Math.abs(r - g) < 12 && Math.abs(g - b) < 12) {
    const level = Math.round(((r + g + b) / 3 - 8) / 247 * 24);
    return 232 + Math.max(0, Math.min(23, level));
  }
  const scale = (value) => Math.round(value / 255 * 5);
  return 16 + 36 * scale(r) + 6 * scale(g) + scale(b);
}

/** Open the escape sequence for a role, or '' when colour is off. */
function open(role) {
  if (!HAS_COLOR) return '';
  const rgb = PALETTE[role];
  if (!rgb) return '';
  if (COLOR_DEPTH >= 16777216) return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
  if (COLOR_DEPTH >= 256) return `\x1b[38;5;${rgbTo256(rgb[0], rgb[1], rgb[2])}m`;
  return `\x1b[${BASIC_CODES[role] || 39}m`;
}

const RESET = '\x1b[0m';

/** Paint `text` in a semantic role. A no-op when colour is unavailable. */
export function paint(role, text) {
  const prefix = open(role);
  return prefix ? `${prefix}${text}${RESET}` : String(text);
}

export function bold(text) {
  return HAS_COLOR ? `\x1b[1m${text}${RESET}` : String(text);
}

export function dim(text) {
  return HAS_COLOR ? `\x1b[2m${text}${RESET}` : String(text);
}

/**
 * Paint a BACKGROUND in a semantic role.
 *
 * The companion to paint(). opencode gives its input surface and each user
 * message a filled background plus a left border, which is what makes them read
 * as blocks rather than as more lines of shell output. This is that fill.
 *
 * Two deliberate degradations:
 *  * no colour at all → returns the text untouched, so NO_COLOR still gets a
 *    clean transcript and the left bar alone carries the block;
 *  * 16-colour terminals → also untouched, because the only greys available
 *    there are black and bright-black, and a slab of either behind body text is
 *    less readable than no fill.
 *
 * The caller pads the text to the block width BEFORE calling: a background only
 * reads as a surface if it extends past the last character.
 */
export function openFill(role) {
  if (!HAS_COLOR) return '';
  const rgb = PALETTE[role];
  if (!rgb) return '';
  if (COLOR_DEPTH >= 16777216) return `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
  if (COLOR_DEPTH >= 256) return `\x1b[48;5;${rgbTo256(rgb[0], rgb[1], rgb[2])}m`;
  return '';
}

export function fill(role, text) {
  const open = openFill(role);
  if (!open) return String(text);

  // Re-open the background after every reset inside the text.
  //
  // THIS is why the box did not look like a box. paint() and dim() each close
  // with \x1b[0m, and \x1b[0m resets EVERY attribute — including the background
  // this function just set. So the fill survived only as far as the first
  // styled word: on a 99-column row the model line was filled for 6 columns and
  // bare for the other 93, and the "surface" read as a stray highlight.
  //
  // Re-establishing the background immediately after each reset costs a few
  // bytes per row and makes the fill continuous whatever the caller styled.
  const body = String(text).split(RESET).join(RESET + open);
  return `${open}${body}${RESET}`;
}

/** A filled badge — used for risk banners, where a fill reads faster than text. */
export function badge(role, text) {
  if (!HAS_COLOR) return `[${text}]`;
  const rgb = PALETTE[role];
  const label = ` ${text} `;
  if (COLOR_DEPTH >= 16777216) {
    return `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m\x1b[38;2;16;16;20m\x1b[1m${label}${RESET}`;
  }
  if (COLOR_DEPTH >= 256) {
    return `\x1b[48;5;${rgbTo256(rgb[0], rgb[1], rgb[2])}m\x1b[30m\x1b[1m${label}${RESET}`;
  }
  return `\x1b[${(BASIC_CODES[role] || 39) + 10}m\x1b[30m${label}${RESET}`;
}

/** Glyph set, degrading to ASCII where Unicode is unsafe. */
export const GLYPHS = HAS_UNICODE
  ? {
      arrow: '▸', check: '✓', cross: '✕', dot: '·', bullet: '•',
      spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
      hLine: '─', vLine: '│', corner: '└', tee: '├', ellipsis: '…',
      // The left accent bar of a block. A half-width bar sits INSIDE its column
      // rather than filling it, so it reads as an edge instead of as a wall —
      // the same weight opencode's border={["left"]} carries.
      bar: '▌', step: '▪',
      // The permission marker. opencode shows a warning triangle and NO risk
      // word — the level is internal plumbing, and printing 'DANGEROUS' at
      // someone just makes them numb to it. Colour still carries the tier.
      warnMark: '△',
      // A CONTINUOUS thick rule, for the one place that needs the eye to read a
      // single unbroken edge: the input box. `▌` is a half BLOCK — it does not
      // fill the cell's full height in most terminal fonts, so a column of them
      // comes out as ragged stubs with gaps nobody chose. `┃` is box-drawing
      // heavy vertical, which is drawn to join between rows.
      barHeavy: '┃',
      // Rounded panel corners, for the session header.
      topLeft: '╭', topRight: '╮', bottomLeft: '╰', bottomRight: '╯'
    }
  : {
      arrow: '>', check: 'v', cross: 'x', dot: '.', bullet: '*',
      spinner: ['|', '/', '-', '\\'],
      hLine: '-', vLine: '|', corner: '`', tee: '+', ellipsis: '...',
      bar: '|', step: '*',
      warnMark: '!',
      barHeavy: '|',
      topLeft: '+', topRight: '+', bottomLeft: '+', bottomRight: '+'
    };

/**
 * Does the terminal turn OSC 8 sequences into clickable links?
 *
 * Deliberately an allowlist. A terminal that does not understand OSC 8 mostly
 * ignores it, but some older ones print the URL as literal text in the middle
 * of a line — so a wrong guess here is visible corruption, and the cost of
 * guessing "no" is only that a path is not clickable.
 */
function detectHyperlinkSupport() {
  if (!HAS_COLOR) return false;                      // piped, or colour opted out
  if (process.env.CAUSYNE_NO_LINKS === '1') return false;
  if (process.env.TERM_PROGRAM === 'Apple_Terminal') return false; // no OSC 8 support

  return Boolean(
    process.env.WT_SESSION ||                        // Windows Terminal
    process.env.KITTY_WINDOW_ID ||
    process.env.VTE_VERSION ||                       // GNOME Terminal, Tilix
    process.env.WEZTERM_PANE ||
    ['iTerm.app', 'WezTerm', 'ghostty', 'vscode', 'Hyper'].includes(process.env.TERM_PROGRAM)
  );
}

export const HAS_HYPERLINKS = detectHyperlinkSupport();

/**
 * Wrap `text` as a clickable link to `url`.
 *
 * ONLY for URLs this process builds itself — a workspace file path, a spill
 * file. Never for a URL taken from tool output or from a model reply: OSC 8 is
 * an escape sequence, and emitting one on behalf of untrusted content is the
 * injection that src/tui/text.js sanitize() exists to prevent.
 *
 * For a URL that DID come from a model reply, use safeLink() below, which
 * rebuilds the URL from a parsed object instead of trusting the string.
 */
export function link(text, url) {
  if (!HAS_HYPERLINKS) return String(text);
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}

/**
 * A link for a URL that came from a model reply or from tool output.
 *
 * The rule above still holds: OSC 8 is an escape sequence, and passing
 * untrusted text into one is an injection. The way to publish a link anyway is
 * not to trust the string — it is to stop treating it as a string. The URL is
 * parsed, rejected unless it is plain http/https, and then RE-SERIALISED from
 * the parsed object through encodeURI, so what reaches the terminal is a URL
 * this process constructed. A payload carrying \x1b, \x07, an OSC terminator or
 * a `javascript:` scheme cannot survive that round trip, and gets printed as
 * ordinary text instead.
 *
 * Returns the plain text unchanged whenever the URL does not clear the bar.
 */
export function safeLink(text, url) {
  if (!HAS_HYPERLINKS) return String(text);

  const raw = String(url || '');
  // 2048 is the practical URL ceiling; beyond it this is a payload, not a link.
  if (raw.length === 0 || raw.length > 2048) return String(text);
  // Any control byte disqualifies the string before it is even parsed.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(raw)) return String(text);

  let parsed;
  try {
    parsed = new URL(raw);
  } catch (e) {
    return String(text);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return String(text);
  if (!parsed.hostname) return String(text);

  // Built from the PARSED url, not from the input.
  const safeUrl = encodeURI(parsed.href).replace(/[\x00-\x1f\x7f]/g, '');
  return `\x1b]8;;${safeUrl}\x1b\\${text}\x1b]8;;\x1b\\`;
}

/** A file path as a clickable file:// link, absolute as OSC 8 requires. */
export function fileLink(text, absolutePath) {
  if (!HAS_HYPERLINKS || !absolutePath) return String(text);
  return link(text, 'file://' + encodeURI(absolutePath));
}

/**
 * The terminal's ACTUAL width. Chrome fills it.
 *
 * This used to clamp to 120. Stretching a window to 220 columns therefore left
 * 101 of them empty: the input box, its fill and the footer all stopped dead
 * two thirds of the way across while the terminal carried on. A hardcoded
 * ceiling cannot follow a window the user is resizing, and the whole point of
 * the box is that it is the surface they are typing into.
 */
export function terminalWidth() {
  const raw = process.stdout.columns || 80;
  return Math.max(40, raw);
}

/**
 * The widest a line of PROSE may be, given the space available.
 *
 * Chrome and text want opposite things from a wide terminal. A box should fill
 * it; a paragraph should not — 200 characters per line is genuinely hard to
 * read, because the eye loses the return sweep. Typographic practice puts the
 * comfortable range at 45-75 characters and the outer limit near 100, which is
 * exactly what native-skills/design/type-scale-and-hierarchy tells the agent to
 * do for anyone else's interface.
 *
 * Expressed as a share of the width rather than a fixed number, so it still
 * responds to the terminal instead of pinning at one value.
 */
export const READABLE_MAX = 100;

export function readableWidth(available = terminalWidth()) {
  return Math.max(40, Math.min(available, READABLE_MAX));
}
