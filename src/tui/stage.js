// The Stage — a bounded, bottom-anchored region Causyne owns and repaints.
//
// WHY THIS IS NOT AN ALTERNATE SCREEN.
//
// opencode's full TUI gets its "the chat scrolls inside a box, the terminal
// does not scroll" behaviour the blunt way: it writes \x1b[?1049h and owns the
// whole screen, so there is no terminal scrollback left to scroll
// (packages/tui/src/app.tsx:190-205, screenMode defaults to "alternate-screen").
// UX-01 forbids Causyne doing that, and the reason is specific and correct: the
// old src/tui/screen.js wrote ALT_ENTER + HOME + CLEAR_ALL unconditionally,
// there is no capability detection for the alternate buffer anywhere, and a
// terminal that silently IGNORES ?1049h does not throw — so the \x1b[2J then
// wiped the user's real screen.
//
// The Stage owns a REGION instead of a screen. Every escape it emits is
// relative, so it is structurally incapable of touching a row it did not write:
//
//   * the band is reserved by emitting newlines, never by absolute addressing;
//   * movement is CUU/CUD only — a newline inside paint() would scroll the
//     terminal out from under the block, so paint() emits none;
//   * one seam row is left above the band, which is the visible proof that this
//     is not an alternate screen;
//   * on exit the band is collapsed and the transcript is flushed to real
//     scrollback (printThrough), so the session stays permanent terminal
//     history — the property UX-01 was actually protecting.
//
// Rendering is a ROW diff, not a cell diff. opencode can afford per-cell
// diffing because @opentui/core ships per-platform Zig binaries over FFI;
// ZM-06 bars that here, so the region is bounded and the granularity is coarser.
// A spinner tick touches one row; a scroll touches all of them, at a
// user-driven rate. Both are cheap at 40x200 in pure JS.
//
// Pure Node: no dependency, no shell.

import { visibleWidth, truncate } from './text.js';

// Below this the band cannot hold a viewport plus an input box plus a footer,
// and a cramped stage is worse than honest scrollback. The fallback is not a
// degraded stage; it is the scrollback renderer, unchanged.
export const MIN_STAGE_ROWS = 16;

// Synchronized output. A terminal that does not implement it ignores both
// halves, so this is free; one that does composites the whole repaint at once,
// which is what stops a scroll from tearing.
const SYNC_ON = '\x1b[?2026h';
const SYNC_OFF = '\x1b[?2026l';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const ERASE_LINE = '\x1b[K';
const ERASE_BELOW = '\x1b[J';

/**
 * How tall the band should be, or 0 for "do not use a stage".
 *
 * CAUSYNE_STAGE: off | auto | <rows> | <pct>%
 */
export function stageHeight(out = process.stdout, env = process.env) {
  const setting = String(env.CAUSYNE_STAGE ?? 'auto').trim().toLowerCase();
  if (setting === 'off' || setting === '0' || setting === 'false') return 0;

  const rows = Number(out && out.rows);
  if (!Number.isFinite(rows) || rows <= 0) return 0;

  // The seam: never take the last row of the user's screen. It costs one row
  // and it is the difference between "a region" and "the screen".
  const ceiling = rows - 1;

  let target = ceiling;
  const percent = /^(\d{1,3})%$/.exec(setting);
  if (percent) target = Math.round((rows * Number(percent[1])) / 100);
  else if (/^\d+$/.test(setting)) target = Number(setting);

  target = Math.min(target, ceiling);
  if (!Number.isFinite(target) || target < MIN_STAGE_ROWS) return 0;
  return target;
}

/**
 * May we run a stage on this stream at all?
 *
 * Everything here is a reason the region could not be repainted safely, so the
 * answer is the scrollback renderer rather than a stage that misbehaves.
 */
export function stageEnabled(out = process.stdout, env = process.env) {
  if (!out || !out.isTTY) return false;
  if (String(env.TERM || '') === 'dumb') return false;
  if (env.CAUSYNE_SIMPLE_INPUT === '1') return false;
  return stageHeight(out, env) > 0;
}

export class Stage {
  constructor({ out = process.stdout, env = process.env, height = 0 } = {}) {
    this.out = out;
    this.env = env;

    // The CEILING, not the size. A band claimed by printing newlines costs the
    // user a real row of terminal for every row it takes, so it takes only what
    // it has something to put in and grows from there. Sizing it to the screen
    // is free on an alternate screen — which is what opencode is — and on a
    // reserved band it is 73 rows of void and a banner scrolled out of sight.
    this.maxHeight = height > 0 ? Math.floor(height) : stageHeight(out, env);
    // Rows actually claimed. Zero until reserve().
    this.height = 0;

    this.reserved = false;
    // Where the caret is, as a row index inside the band. reserve() leaves it
    // on the band's last row, because that is where the newlines end.
    this.cursor = 0;
    // What is currently on screen, row for row. The diff is against this.
    this.prev = [];
    this.caret = { row: 0, col: 0 };

    // Measured, so the tests can assert the diff actually diffs.
    // `claimed` is what makes the newline invariant checkable: every newline the
    // Stage ever emits is a row it claimed, and paint() emits none. The old
    // phrasing — "nothing after reserve emits a newline" — could not survive a
    // band that grows, and conflated the claim path with the paint path.
    this.stats = { paints: 0, rowsWritten: 0, bytes: 0, claimed: 0 };
  }

  width() {
    const columns = Number(this.out && this.out.columns);
    return Number.isFinite(columns) && columns > 0 ? Math.max(20, columns) : 80;
  }

  /** Rows available to the caller for content, i.e. the whole band. */
  get rows() {
    return this.height;
  }

  write(text) {
    if (!text) return;
    this.stats.bytes += text.length;
    this.out.write(text);
  }

  /**
   * Claim the band.
   *
   * Emitting `height` newlines is the whole mechanism. It scrolls whatever was
   * on screen up into the terminal's own scrollback — the same thing any
   * program that prints does — and leaves the caret on the band's last row.
   * With height = rows - 1 this lands on the bottom row from any starting
   * position, which is what anchors the band without absolute addressing.
   */
  reserve(rows = this.maxHeight) {
    if (this.reserved || this.maxHeight < 1) return false;
    const claim = Math.max(1, Math.min(Math.floor(rows), this.maxHeight));
    this.write('\n'.repeat(claim));
    this.stats.claimed += claim;
    this.reserved = true;
    this.height = claim;
    this.cursor = claim - 1;
    this.prev = new Array(claim).fill(null);
    this.caret = { row: claim - 1, col: 0 };
    return true;
  }

  /**
   * Claim more rows, up to the ceiling.
   *
   * Newlines emitted from the band's last row scroll the screen and leave the
   * new rows at the BOTTOM, so in band coordinates growth appends: rows 0..h-1
   * keep what they had and the new ones arrive blank. That is why `prev` is
   * extended with nulls rather than rebuilt — the diff keeps everything it
   * already knows and only pays for what actually changed.
   *
   * Growth scrolls whatever is above the band up by the same amount, which is
   * what any program that prints does, and is the only thing UX-01 rev 2 clause
   * (b) permits to move it.
   */
  grow(delta) {
    if (!this.reserved || delta <= 0) return 0;
    const room = this.maxHeight - this.height;
    const claim = Math.min(Math.floor(delta), room);
    if (claim <= 0) return 0;

    this.moveTo(this.height - 1);
    this.write('\n'.repeat(claim));
    this.stats.claimed += claim;
    this.height += claim;
    this.cursor = this.height - 1;
    for (let i = 0; i < claim; i++) this.prev.push(null);
    return claim;
  }

  /**
   * Normalise a caller's rows to exactly `height` rows, each safe to write.
   *
   * The width clamp is the invariant everything rests on and it is the same one
   * ChatPrompt.clampRows() enforces: a row wider than the terminal occupies TWO
   * physical rows, and one wrap desynchronises every relative move that follows
   * it. The spare column also avoids the terminal's deferred-wrap state at the
   * exact margin.
   */
  normalize(rows) {
    const limit = Math.max(1, this.width() - 1);
    const out = new Array(this.height);
    for (let i = 0; i < this.height; i++) {
      let row = rows && rows[i] != null ? String(rows[i]) : '';
      if (row.includes('\n')) row = row.split('\n')[0];
      out[i] = visibleWidth(row) <= limit ? row : truncate(row, limit, '');
    }
    return out;
  }

  moveTo(row) {
    const target = Math.max(0, Math.min(row, this.height - 1));
    const delta = target - this.cursor;
    // CUU/CUD only. Never a newline: on the band's last row a newline scrolls
    // the terminal, which would move the whole block out from under the diff.
    if (delta < 0) this.write(`\x1b[${-delta}A`);
    else if (delta > 0) this.write(`\x1b[${delta}B`);
    this.cursor = target;
  }

  /**
   * Repaint the band. Rows that did not change cost nothing.
   *
   * Returns the number of rows actually written, so a test can assert that an
   * idle frame is free.
   */
  paint(rows, caret = null) {
    if (!this.reserved) return 0;

    const next = this.normalize(rows);
    const target = caret && Number.isFinite(caret.row)
      ? { row: Math.max(0, Math.min(Math.floor(caret.row), this.height - 1)), col: Math.max(0, Math.floor(caret.col) || 0) }
      : { row: this.height - 1, col: 0 };

    const changed = [];
    for (let i = 0; i < this.height; i++) {
      if (next[i] !== this.prev[i]) changed.push(i);
    }

    const caretMoved = target.row !== this.caret.row || target.col !== this.caret.col;
    // A frame with nothing to say emits zero bytes. opencode's renderer makes
    // the same bet and calls it out as its main anti-flicker mechanism.
    if (changed.length === 0 && !caretMoved) return 0;

    this.write(SYNC_ON + HIDE_CURSOR);
    for (const i of changed) {
      this.moveTo(i);
      this.write('\r' + next[i] + ERASE_LINE);
    }
    this.moveTo(target.row);
    this.write('\r');
    if (target.col > 0) this.write(`\x1b[${target.col}C`);
    this.write(SHOW_CURSOR + SYNC_OFF);

    this.prev = next;
    this.caret = target;
    this.stats.paints++;
    this.stats.rowsWritten += changed.length;
    return changed.length;
  }

  /**
   * Give the band back.
   *
   * Erases from the band's top row down. ED 0 clears from the caret to the end
   * of the screen, which is exactly the band and nothing above it. It is not
   * the whole-screen erase (ED 2) that UX-01 bans, and the source scan in
   * tests/chatSurface.test.js is what keeps the two from being confused.
   */
  collapse() {
    if (!this.reserved) return;
    this.write(SYNC_ON);
    this.moveTo(0);
    this.write('\r' + ERASE_BELOW + SHOW_CURSOR + SYNC_OFF);
    this.reserved = false;
    this.cursor = 0;
    this.prev = [];
  }

  /**
   * The exit contract: the session becomes permanent terminal history.
   *
   * Call after collapse(). opencode's alternate-screen TUI leaves nothing
   * behind and its split-footer mode leaves everything but cannot scroll;
   * doing both is the point of the Stage.
   */
  printThrough(lines) {
    if (!Array.isArray(lines) || lines.length === 0) return 0;
    let written = 0;
    let chunk = '';
    for (const line of lines) {
      chunk += (line == null ? '' : String(line)) + '\n';
      written++;
      if (chunk.length > 16384) { this.write(chunk); chunk = ''; }
    }
    if (chunk) this.write(chunk);
    return written;
  }

  /**
   * Terminal resized.
   *
   * Collapse and re-reserve rather than trying to grow or shrink in place. The
   * band's geometry is the one thing the diff cannot recover from being wrong
   * about, and a resize already costs a full reflow of the transcript; one
   * extra scroll per settled gesture is the cheap half. Callers must debounce
   * (ChatPrompt already settles resize at 60ms).
   */
  resize(height = 0, claim = 0) {
    const next = height > 0 ? Math.floor(height) : stageHeight(this.out, this.env);
    const wasReserved = this.reserved;
    if (wasReserved) this.collapse();
    this.maxHeight = next;
    this.height = 0;
    if (next < 1) return false;
    if (wasReserved) return this.reserve(claim > 0 ? claim : next);
    return false;
  }

  /**
   * Force the next paint to redraw every row.
   *
   * Anything that writes to the terminal behind the Stage's back (an evicted
   * frame flushed to scrollback, a print-through) invalidates the diff.
   */
  invalidate() {
    this.prev = new Array(this.height).fill(null);
  }

  /** Rows still available before the band hits its ceiling. */
  get room() {
    return Math.max(0, this.maxHeight - this.height);
  }
}
