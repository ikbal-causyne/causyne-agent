// StageSurface — what ChatPrompt draws into when the Stage is running.
//
// It owns the three pieces and nothing else owns any of them: the Transcript
// (the model), the Viewport (where we are in it), and the Stage (the band of
// terminal rows). ChatPrompt keeps composing exactly the rows it always
// composed; instead of writing them to stdout it hands them here, and this
// decides how much of the band is left over for the transcript.
//
// The layout of the band, top to bottom:
//
//     [ viewport rows ]   height - promptRows.length, app-scrolled
//     [ prompt block  ]   the input box, picker, notice and status footer
//
// So the viewport shrinks as the input box grows, which is the behaviour you
// want and which falls out of the arithmetic rather than needing a rule.
//
// THE EXIT CONTRACT lives here (UX-01 rev 2 clause d): close() collapses the
// band and flushes the whole session into real terminal scrollback. opencode's
// alternate-screen TUI leaves nothing behind and its split-footer mode leaves
// everything but cannot scroll; doing both is the entire point.
//
// Pure Node: no dependency, no shell.

import { Stage, stageHeight } from './stage.js';
import { Transcript } from './transcript.js';
import { Viewport, ScrollAcceleration, DEFAULT_SCROLL_SPEED } from './viewport.js';
import { paint, GLYPHS } from './theme.js';
import { mouseTracking } from './keys.js';
import { truncate, padEnd, visibleWidth } from './text.js';

// Rows of evicted transcript held for the exit log. Eviction only happens after
// MAX_FRAMES, so this is a bound on a pathological session, not a working limit.
const MAX_EVICTED_ROWS = 40000;

// Below this the prompt block gets the whole band and the transcript is not
// shown at all — which is a broken screen, so the prompt is trimmed instead.
const MIN_VIEWPORT_ROWS = 2;

// Fallback measure for the opening composition, used only when the caller does
// not hand over the banner's real width.
//
// The session banner comes out ~82 columns wide (the wordmark beside its facts
// column, and the workspace path under it). While the input box stretched the
// full width of a large terminal, the two read as unrelated objects — a thin line
// pulled across a wide emptiness under a block that stops two-thirds of the way.
// Ninety sits just above the banner and just below the 100-column prose measure
// theme.js already uses, so the opening reads as ONE panel.
//
// It applies ONLY while the transcript is empty. The session input box keeps
// filling the window, which is an established layout invariant — tuiWidth
// asserts "the input box fills a stretched terminal" after a hardcoded 120-column
// ceiling was torn out of three modules for leaving a wide terminal two-thirds
// covered. This does not reopen that: it is a different rule for a different
// moment, and it lifts the instant a session begins.
const OPENING_FALLBACK_WIDTH = 100;

// The rail costs a column plus a column of air. On a narrow terminal those two
// are worth more as text, so it turns itself off rather than crowding the
// transcript it exists to help you navigate.
//
// It costs THREE columns of content, not two: a composed row is
// contentWidth + air + rail, and the Stage clamps every row to width - 1 so a
// wrap can never desynchronise the diff. Budgeting only two put the rail in the
// column that gets truncated away, which is a rail that renders and is then
// silently cut off — the tests caught it, which is what they are for.
const RAIL_MIN_WIDTH = 60;
const RAIL_WIDTH = 2;
const RAIL_BUDGET = RAIL_WIDTH + 1;

// Which marker wins when several frames fall in the same rail row. A proportional
// rail on a long session compresses dozens of frames per row, and what you want
// to see at a glance is the thing that went wrong or the thing you can roll back
// to — not the forty step rows around them.
// Inside the thumb, only a marker this loud overrides the position indicator.
//
// Two passes to get this right. The first draft let ANY marker win, and a dense
// session put a marker in every slot — so the thumb, the one thing on the rail
// that says WHERE YOU ARE, was invisible exactly when the rail mattered most.
// The second draft set the bar at checkpoints, and a real session on a pty
// showed why that is still wrong: a restore point is taken on every file write,
// so the thumb came out as `▌▌▪▪▪▌` — shredded by the most routine event there
// is. Only what is rare AND urgent is worth a row of position: an error, or an
// approval waiting on the user.
const RAIL_THUMB_YIELD = 80;

const RAIL_PRIORITY = {
  error: 90, approval: 80, checkpoint: 70, turn: 60, user: 50,
  assistant: 40, reasoning: 30, skill: 25, plan: 20,
  session: 15, step: 10, result: 5, notice: 1
};

/**
 * One row of the position indicator: a continuous rule with ONE dot at its
 * middle. Line, dot, line — the same motif the input box carries.
 *
 * Alternating every other row was the first attempt and it was wrong: over a
 * thumb of any length it reads as a long dashed line, which is the thing it was
 * supposed to stop looking like. One dot at the centre makes even a full-track
 * thumb read as a single object rather than as a run of broken marks.
 *
 * `│` is used by no marker, which is what lets a test find the thumb at all.
 */
function thumbGlyph(offsetInThumb, thumbLength) {
  const middle = thumbLength >= 3 ? Math.floor(thumbLength / 2) : -1;
  return offsetInThumb === middle ? GLYPHS.dot : GLYPHS.vLine;
}

/**
 * One rail cell. Every glyph is an existing GLYPH — the ambiguous-width set is
 * already accounted for by visibleWidth(), and a new character here would be a
 * new way for a row to measure one column and render two.
 */
function railGlyph(kind) {
  switch (kind) {
    case 'error':      return paint('danger', GLYPHS.cross);
    case 'approval':   return paint('warn', GLYPHS.step);
    case 'checkpoint': return paint('success', GLYPHS.step);
    case 'turn':       return paint('rule', GLYPHS.hLine);
    case 'user':       return paint('user', GLYPHS.arrow);
    case 'assistant':  return paint('agent', GLYPHS.arrow);
    case 'reasoning':  return paint('muted', GLYPHS.dot);
    default:           return paint('rule', GLYPHS.dot);
  }
}

/**
 * Wheel tuning, from the environment first and the saved config second.
 *
 * Env wins because every other Stage switch is an env var (CAUSYNE_STAGE,
 * CAUSYNE_MOUSE, CAUSYNE_RAIL) and a user debugging a terminal wants one place to
 * turn things off. The config file is where a preference lives once it is
 * settled.
 */
export function scrollSettings(env = process.env, config = null) {
  const tui = (config && typeof config === 'object' && config.tui) || {};

  let speed = Number(env.CAUSYNE_SCROLL_SPEED);
  if (!Number.isFinite(speed) || speed <= 0) speed = Number(tui.scrollSpeed);
  if (!Number.isFinite(speed) || speed <= 0) speed = DEFAULT_SCROLL_SPEED;
  // A wheel that moves half the screen per notch is not a preference, it is a
  // misconfiguration; clamp rather than obey it.
  speed = Math.min(speed, 20);

  const raw = env.CAUSYNE_SCROLL_ACCEL;
  const accelerate = raw !== undefined && raw !== ''
    ? raw === '1' || raw === 'true'
    : Boolean(tui.scrollAcceleration);

  return { speed, accelerate };
}

export class StageSurface {
  constructor({ out = process.stdout, env = process.env, config = null, speed, accelerate, openingWidth = 0 } = {}) {
    this.out = out;
    this.env = env;

    this.stage = new Stage({ out, env });
    this.transcript = new Transcript({
      onEvict: (rows) => this.absorbEvicted(rows),
      onChange: () => this.handleChange()
    });
    const tuning = scrollSettings(env, config);
    this.viewport = new Viewport({
      transcript: this.transcript,
      height: Math.max(MIN_VIEWPORT_ROWS, this.stage.height - 2),
      width: this.stage.width(),
      speed: speed !== undefined ? speed : tuning.speed,
      acceleration: (accelerate !== undefined ? accelerate : tuning.accelerate)
        ? new ScrollAcceleration()
        : null
    });

    // Rows that fell out of the model. Not shown, not lost: they are printed
    // ahead of the transcript on the way out.
    this.evicted = [];
    this.lastHeight = 0;
    // Set by ChatPrompt.attachSurface.
    this.onDirty = null;
    this.exitHook = null;
    this.signalHooks = [];
    // UX-02: opt out entirely, for anyone whose terminal or workflow this gets
    // in the way of.
    this.mouseWanted = String(env.CAUSYNE_MOUSE ?? '1') !== '0';
    this.mouseOn = false;

    // The width the banner above the band actually used, handed over by the
    // caller that printed it. Zero means "nobody measured", and the fallback
    // applies.
    this.openingWidth = Number.isFinite(openingWidth) && openingWidth > 0
      ? Math.floor(openingWidth)
      : 0;

    // Has anything ever landed in this session?
    //
    // NOT the same question as "is the transcript empty", and the difference is
    // a real defect: /print and ctrl+L empty the transcript, so keying on
    // emptiness narrowed the input box back to the banner's measure long after
    // the banner had scrolled out of view — the box visibly shrinking for a
    // reason the user cannot see. The opening measure belongs to THE opening,
    // once, not to every empty moment after it.
    this.opened = false;
  }

  get width() {
    return this.stage.width();
  }

  /**
   * The width the prompt block should be composed to.
   *
   * Deliberately NOT centred, which is where Causyne parts company with the
   * reference on purpose. opencode centres its logo and prompt because its logo
   * is centred in a screen it owns (routes/home.tsx:72-90). Causyne's banner is
   * left-aligned in the user's real scrollback, so a centred input box below it
   * would be misaligned with the very thing it is supposed to belong to. Same
   * origin, same measure: the opening reads as a document block, not a splash.
   */
  composeWidth() {
    const width = this.width;
    if (this.opened || !this.transcript.isEmpty()) return width;
    const measure = this.openingWidth > 0 ? this.openingWidth : OPENING_FALLBACK_WIDTH;
    return Math.min(width, measure);
  }

  /**
   * Claim the band and arm the exit safety net.
   *
   * The hook matters: if the process dies without going through stop(), the
   * band's rows are ordinary terminal text and nothing is corrupted, but the
   * session would not reach scrollback. A synchronous exit handler is enough
   * because collapse and print-through are plain writes.
   */
  open() {
    // ONE row, not the whole screen.
    //
    // The band used to be born at `rows - 1` regardless of what it had to show.
    // Measured at 156x78: the banner's 12 rows plus a 77-row band came to 89 on
    // a 78-row screen, so the wordmark was scrolled 11 rows out of sight before
    // the user had typed anything, and 73 of the 77 claimed rows were empty.
    // present() grows it to fit what there actually is.
    if (!this.stage.reserve(1)) return false;
    this.enableMouse();
    this.armTeardown();
    return true;
  }

  enableMouse() {
    if (!this.mouseWanted || this.mouseOn) return false;
    this.out.write(mouseTracking(true));
    this.mouseCaptured = true;
    this.mouseOn = true;
    return true;
  }

  disableMouse() {
    if (!this.mouseOn) return false;
    this.out.write(mouseTracking(false));
    this.mouseCaptured = false;
    this.mouseOn = false;
    return true;
  }

  
  armTeardown() {
    this.exitHook = () => { try { this.close(); } catch { /* nothing left to do */ } };
    process.once('exit', this.exitHook);

    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      const handler = () => {
        try { this.close(); } catch { /* keep going: the exit matters more */ }
        // Re-raise the conventional status so a caller waiting on us still sees
        // that we were signalled rather than that we exited cleanly.
        process.exit(128 + { SIGINT: 2, SIGTERM: 15, SIGHUP: 1 }[signal]);
      };
      process.on(signal, handler);
      this.signalHooks.push([signal, handler]);
    }
  }

  disarmTeardown() {
    if (this.exitHook) {
      process.removeListener('exit', this.exitHook);
      this.exitHook = null;
    }
    for (const [signal, handler] of this.signalHooks) process.removeListener(signal, handler);
    this.signalHooks = [];
  }

  close() {
    // Mouse first, unconditionally: it is the one piece of state that outlives
    // the process and damages the terminal the user goes back to.
    this.disableMouse();
    if (!this.stage.reserved) { this.disarmTeardown(); return false; }
    const rows = this.snapshot();
    this.stage.collapse();
    this.stage.printThrough(rows);
    this.disarmTeardown();
    return true;
  }

  /**
   * Hand the terminal back to something that is about to write to it directly,
   * then take it again.
   *
   * Anything spawned with stdio: 'inherit' writes straight into the band and
   * the diff has no idea it happened. Causyne has four such call sites today
   * (autoUpdate's two npm installs, the cortex provisioner, the capability
   * provisioner); none of them is wired to this yet, and that is recorded as an
   * open item rather than left to be discovered.
   */
  suspend() {
    if (!this.stage.reserved) return false;
    this.disableMouse();
    this.stage.collapse();
    return true;
  }

  resume() {
    if (this.stage.reserved) return false;
    if (!this.stage.reserve()) return false;
    this.stage.invalidate();
    this.enableMouse();
    return true;
  }

  /** Everything the session produced, oldest first. */
  snapshot() {
    return this.evicted.concat(this.transcript.snapshot(this.width));
  }

  absorbEvicted(rows) {
    for (const row of rows) this.evicted.push(row);
    if (this.evicted.length > MAX_EVICTED_ROWS) {
      this.evicted.splice(0, this.evicted.length - MAX_EVICTED_ROWS);
    }
  }

  handleChange() {
    if (!this.transcript.isEmpty()) this.opened = true;
    const before = this.lastHeight;
    const after = this.transcript.height(this.width);
    this.lastHeight = after;
    // Growth is what drives auto-scroll. Handing the delta over is also what
    // lets the "N new below" affordance count only what arrived while the user
    // was reading somewhere else.
    this.viewport.refresh(Math.max(0, after - before));
    if (this.onDirty) this.onDirty();
  }

  // -------------------------------------------------------------------------
  // The interface ChatPrompt calls
  // -------------------------------------------------------------------------

  /**
   * Append a permanent frame. `produce` must be a pure function of width — see
   * the contract in transcript.js.
   */
  commit(kind, produce, meta = null) {
    return this.transcript.append({ kind, produce, meta });
  }

  /**
   * Paint the band: viewport on top, the prompt's own rows underneath.
   */
  present(promptRows, caret = null) {
    if (!this.stage.reserved) return 0;

    const width = this.width;
    const rail = this.railEnabled(width);
    const contentWidth = rail ? Math.max(20, width - RAIL_BUDGET) : width;

    let block = promptRows;
    let caretRow = caret && Number.isFinite(caret.row) ? caret.row : Math.max(0, block.length - 1);

    // Grow the band to what there is to show, before deciding anything else.
    //
    // An empty session wants exactly the prompt and no more — no viewport, no
    // void, and no rows taken from the user's terminal that nothing is going to
    // fill. As the transcript grows the band follows it, up to the ceiling; it
    // never shrinks, because shrinking would mean erasing rows the diff believes
    // it owns and fighting the resize path for them.
    const contentRows = this.transcript.height(contentWidth);
    const desired = Math.min(this.stage.maxHeight, block.length + contentRows);
    if (desired > this.stage.height) this.stage.grow(desired - this.stage.height);

    const height = this.stage.height;

    // The prompt may not eat the whole band — but only once there is a
    // transcript for it to eat. Trim from the TOP when it would: the status
    // footer and the caret row are the last rows and the ones worth keeping,
    // and an input box that has scrolled its own oldest row off is a smaller lie
    // than a transcript that has vanished.
    const floor = contentRows > 0 ? MIN_VIEWPORT_ROWS : 0;
    const maxBlock = Math.max(1, height - floor);
    if (block.length > maxBlock) {
      const cut = block.length - maxBlock;
      block = block.slice(cut);
      caretRow = Math.max(0, caretRow - cut);
    }

    const budget = Math.max(0, height - block.length);
    let rows = [];
    if (budget > 0) {
      this.viewport.resize({ height: budget, width: contentWidth });
      rows = this.viewport.rows();
      this.decorate(rows, contentWidth);
      if (rail) this.attachRail(rows, contentWidth);
    }

    // DO NOT PAINT WHILE THE TERMINAL OWNS THE SCROLL.
    //
    // The Stage repaints by DIFF against the rows it believes are on screen. It
    // has no way to know the user scrolled the terminal's own scrollback, and
    // when they do, the band's absolute rows move while the diff keeps writing
    // to the old coordinates — which is how a session ends up with a stray rail
    // column down the middle and fragments of old frames at the edges.
    //
    // We cannot detect a terminal scroll directly. What we CAN detect is the
    // moment we handed the wheel over (viewport at its top, mouse reporting
    // released), and from then until the user types again the terminal is the
    // thing scrolling. Painting nothing is correct: the band is not where we
    // left it, so every write would land somewhere wrong.
    if (this.detached) return false;

    return this.stage.paint(rows.concat(block), {
      row: rows.length + caretRow,
      col: caret ? caret.col : 0
    });
  }

  /**
   * The one thing on screen that opencode does not have: while the view is held
   * away from the bottom, say so and say how much arrived.
   *
   * Without it, un-following is invisible — the transcript simply stops moving
   * and the user cannot tell whether the agent stalled or they scrolled.
   */
  decorate(rows, width) {
    const state = this.viewport.state();
    if (state.following) return rows;

    const count = state.unseen;
    const label = count > 0
      ? `${GLYPHS.arrow} ${count} new below`
      : `${GLYPHS.arrow} scrolled up`;
    const hint = `${label}  ${GLYPHS.dot}  shift+pgdn to follow`;
    rows[rows.length - 1] = paint('accent', truncate(hint, Math.max(8, width - 1), GLYPHS.ellipsis));
    return rows;
  }

  /**
   * Ctrl+L: flush what is on the stage into real scrollback, then start clean.
   *
   * In a terminal, ctrl+L clears the screen and your history is still in
   * scrollback. Clearing the transcript alone would destroy the session record,
   * which is not what the key means — so print it through first. This is also
   * the escape hatch for getting a transcript into the terminal without exiting.
   */
  flushAndClear() {
    const rows = this.snapshot();
    this.stage.collapse();
    this.stage.printThrough(rows);
    this.evicted = [];
    this.transcript.clear();
    this.lastHeight = 0;
    this.stage.reserve();
    this.stage.invalidate();
    this.viewport.toBottom();
    return rows.length;
  }

  /**
   * The terminal changed size. Callers must debounce — ChatPrompt already
   * settles resize at RESIZE_SETTLE_MS.
   */
  resize() {
    const next = stageHeight(this.out, this.env);
    if (next < 1) {
      // The terminal became too short to hold a stage. Give the band back and
      // let the caller fall through to the scrollback renderer rather than
      // painting into a region that cannot hold a viewport.
      this.close();
      return false;
    }
    // Re-claim only what the content justifies; present() grows it from there.
    this.stage.resize(next, 1);
    this.stage.invalidate();
    // Re-derive from the new geometry: growing the viewport lowers maxScrollTop,
    // and leaving scrollTop above it would read as "the user scrolled away".
    this.viewport.resize({ height: Math.max(MIN_VIEWPORT_ROWS, this.stage.height - 2), width: this.width });
    this.lastHeight = this.transcript.height(this.width);
    return this.stage.reserved;
  }

  /**
   * Does this terminal get a rail?
   */
  railEnabled(width) {
    if (String(this.env.CAUSYNE_RAIL ?? '1') === '0') return false;
    return width >= RAIL_MIN_WIDTH;
  }

  /**
   * The rail: the WHOLE session compressed into one column, plus where you are
   * in it.
   *
   * Proportional, not per-row. A per-row gutter would only mark what is already
   * on screen, which tells you nothing you cannot see; mapping the entire
   * transcript onto the column means a glance answers "how far in am I, and is
   * there anything back there worth going to". opencode has no equivalent —
   * its scrollbar reports position and nothing about content.
   *
   * Returns `height` single-column strings.
   */
  buildRail(height, contentWidth) {
    const total = Math.max(1, this.transcript.height(contentWidth));
    const slotOf = (row) => Math.max(0, Math.min(height - 1, Math.floor((row / total) * height)));

    const kinds = new Array(height).fill(null);
    for (const marker of this.transcript.markers(contentWidth)) {
      const slot = slotOf(marker.row);
      const held = kinds[slot];
      if (!held || (RAIL_PRIORITY[marker.kind] || 0) > (RAIL_PRIORITY[held] || 0)) {
        kinds[slot] = marker.kind;
      }
    }

    const state = this.viewport.state();
    // Nothing to scroll, no thumb. A scrollbar whose track is full says the same
    // thing as no scrollbar at all, and on an empty session it filled the whole
    // column with position indicator for a position that could not change —
    // noise where the rail is supposed to be information.
    const scrollable = state.max > 0;
    const from = scrollable ? slotOf(state.scrollTop) : -1;
    const to = scrollable ? slotOf(Math.max(state.scrollTop, state.scrollTop + state.height - 1)) : -2;

    const cells = new Array(height);
    for (let i = 0; i < height; i++) {
      const inThumb = i >= from && i <= to;
      const kind = kinds[i];
      const loud = kind && (RAIL_PRIORITY[kind] || 0) >= RAIL_THUMB_YIELD;
      if (kind && (!inThumb || loud)) cells[i] = railGlyph(kind);
      else if (inThumb) cells[i] = paint('scroll', thumbGlyph(i - from, to - from + 1));
      else cells[i] = ' ';
    }
    return cells;
  }

  /**
   * Lay the rail beside the viewport rows.
   *
   * The rows were rendered at contentWidth, so padding them out to it is what
   * keeps the rail in one column instead of ragged against the text.
   */
  attachRail(rows, contentWidth) {
    const rail = this.buildRail(rows.length, contentWidth);
    for (let i = 0; i < rows.length; i++) {
      rows[i] = `${padEnd(rows[i], contentWidth)} ${rail[i]}`;
    }
    return rows;
  }

  /**
   * Hand the wheel back to the terminal.
   *
   * THE SEAM THIS EXISTS FOR. Two things scroll: this band's viewport, and the
   * terminal's own scrollback above it, which holds everything already flushed.
   * With ?1000 on, the app receives every wheel report and the terminal receives
   * none — so once the viewport reached its top, scrolling further did nothing
   * at all and the earlier conversation was unreachable by wheel. Releasing at
   * the boundary is what makes the two halves feel like one scroll.
   */
  releaseMouse() {
    if (!this.mouseCaptured) return false;
    this.out.write(mouseTracking(false));
    this.mouseCaptured = false;
    this.detached = true;
    return true;
  }

  /** Take it back, once the user is driving the band again. */
  captureMouse() {
    if (this.mouseCaptured) return false;
    this.out.write(mouseTracking(true));
    this.mouseCaptured = true;
    this.detached = false;
    // Every row the diff remembers is stale — the terminal has scrolled under
    // us. Redraw the whole band rather than trusting a single cached row.
    this.stage.invalidate();
    return true;
  }
}

/**
 * Build a surface, or null when this terminal should keep the scrollback
 * renderer. Every null here is a reason the region could not be repainted
 * safely, and the fallback is the behaviour Causyne has always had.
 */
export function createStageSurface({ out = process.stdout, env = process.env, config = null, speed, openingWidth = 0 } = {}) {
  if (!out || !out.isTTY) return null;
  if (String(env.TERM || '') === 'dumb') return null;
  if (env.CAUSYNE_SIMPLE_INPUT === '1') return null;
  if (stageHeight(out, env) < 1) return null;

  const surface = new StageSurface({ out, env, config, speed, openingWidth });
  if (!surface.open()) return null;
  return surface;
}

