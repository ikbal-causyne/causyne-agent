// The retained transcript — the model the Stage scrolls over.
//
// ChatRenderer was a pure formatter into stdout: every transcript row was
// `stdout.write(line + '\n')` and nothing was kept. That is exactly right for a
// scrollback surface, where the terminal IS the model — and it makes a viewport
// impossible, because a viewport has to answer "what are rows 400..440 at 96
// columns" long after those rows were produced.
//
// FRAMES, NOT ROWS. A frame is (kind, produce(width) -> string[]). Storing the
// rendered rows instead would mean a resize could not reflow: that is the
// failure opencode's --mini mode actually has, where the only way to handle a
// resize is to clear the saved lines and re-emit the entire transcript
// (packages/opencode/src/cli/cmd/run/runtime.lifecycle.ts:373-398). Storing the
// producer makes a resize a re-render, which is both cheaper and correct.
//
// The producer must be a pure function of width. That is a real constraint on
// the caller: every value that depends on wall-clock time or on renderer state
// (a step number, an elapsed duration, the model name at the time) has to be
// resolved BEFORE the closure is built, not read from inside it. ChatRenderer
// separates its state mutations from its rendering for exactly this reason.
//
// Pure JS over nothing at all. No dependency, no shell.

// Frames kept re-renderable. A frame is small — a closure plus the message it
// closed over — so this is a bound on pathological sessions, not a working
// limit. Overflow is not lost: it goes to onEvict, which the Stage wires to
// real terminal scrollback, so eviction degrades to today's behaviour instead
// of dropping history.
export const MAX_FRAMES = 4000;

// A frame kind is a semantic label, not a style. The rail (and, later, the
// jump bindings) index on it, so it must survive a change of theme.
export const KINDS = Object.freeze([
  'session', 'user', 'assistant', 'reasoning', 'plan', 'step', 'result',
  'approval', 'notice', 'error', 'skill', 'turn', 'checkpoint'
]);

function normalizeRows(produced) {
  if (!Array.isArray(produced)) return [];
  const rows = [];
  for (const row of produced) {
    const text = row == null ? '' : String(row);
    // A frame may never contain a newline: the Stage paints with relative
    // cursor motion only, and one embedded '\n' would scroll the terminal out
    // from under the whole block. Split rather than drop, so nothing is lost.
    if (text.includes('\n')) rows.push(...text.split('\n'));
    else rows.push(text);
  }
  return rows;
}

export class Transcript {
  constructor({ maxFrames = MAX_FRAMES, onEvict = null, onChange = null } = {}) {
    this.frames = [];
    this.maxFrames = Math.max(1, maxFrames);
    this.onEvict = typeof onEvict === 'function' ? onEvict : null;
    // Fired after any structural change. In scrollback mode the renderer's
    // onAfterWrite hook is what tells the prompt to repaint; in stage mode no
    // byte reaches the terminal, so the model has to say so itself.
    this.onChange = typeof onChange === 'function' ? onChange : null;

    this.nextId = 1;
    // Bumped on every structural change. The Stage compares it to decide
    // whether a repaint is needed at all; opencode's renderer makes the same
    // bet (a frame with nothing to say emits zero bytes).
    this.revision = 0;
    this.evictedFrames = 0;
    this.evictedRows = 0;

    // Flattened view, memoised per width.
    this.cache = null;
    // The width the most recent flatten used, so eviction can render a frame
    // one last time on its way out.
    this.lastWidth = 80;
  }

  get length() {
    return this.frames.length;
  }

  isEmpty() {
    return this.frames.length === 0;
  }

  /**
   * Append one frame.
   *
   * `produce` is called lazily and may be called again at a different width.
   * It must not mutate anything the caller will read later.
   */
  append({ kind = 'notice', produce, meta = null } = {}) {
    if (typeof produce !== 'function') return null;
    const frame = {
      id: this.nextId++,
      kind: KINDS.includes(kind) ? kind : 'notice',
      ts: Date.now(),
      meta,
      produce,
      rows: null,
      renderedWidth: -1
    };
    this.frames.push(frame);
    this.cache = null;
    this.revision++;
    this.evictOverflow();
    this.changed();
    return frame.id;
  }

  /**
   * Replace the newest frame in place.
   *
   * Streaming needs this: the tail of an assistant reply is re-rendered as
   * tokens arrive, and appending a frame per token would make the rail useless
   * and the flatten quadratic.
   */
  replaceTail({ kind, produce, meta } = {}) {
    const frame = this.frames[this.frames.length - 1];
    if (!frame || typeof produce !== 'function') return this.append({ kind, produce, meta });
    if (kind && KINDS.includes(kind)) frame.kind = kind;
    if (meta !== undefined) frame.meta = meta;
    frame.produce = produce;
    frame.rows = null;
    frame.renderedWidth = -1;
    this.cache = null;
    this.revision++;
    this.changed();
    return frame.id;
  }

  changed() {
    if (!this.onChange) return;
    // A listener that throws must not take the transcript down with it: the
    // model is the session's memory and a repaint is only a picture of it.
    try { this.onChange(this); } catch { /* the surface will catch up next frame */ }
  }

  evictOverflow() {
    while (this.frames.length > this.maxFrames) {
      const frame = this.frames.shift();
      const rows = this.renderFrame(frame, this.lastWidth);
      this.evictedFrames++;
      this.evictedRows += rows.length;
      this.cache = null;
      // Eviction is not deletion. The Stage hands these to the terminal, where
      // they become permanent scrollback exactly as they would have in the
      // scrollback renderer.
      if (this.onEvict) {
        try { this.onEvict(rows, frame); } catch { /* a sink that throws must not kill the session */ }
      }
    }
  }

  renderFrame(frame, width) {
    if (frame.rows && frame.renderedWidth === width) return frame.rows;
    let produced = [];
    try {
      produced = frame.produce(width);
    } catch {
      // A formatter that throws must cost one frame, not the session. The frame
      // stays in place so the rail and the row count remain stable.
      produced = [];
    }
    frame.rows = normalizeRows(produced);
    frame.renderedWidth = width;
    return frame.rows;
  }

  /**
   * Every row of the transcript at this width, plus the marker index.
   *
   * Memoised on (width, revision): a repaint at an unchanged width and an
   * unchanged transcript costs one comparison.
   */
  flatten(width) {
    const w = Math.max(1, Math.floor(width) || 1);
    if (this.cache && this.cache.width === w && this.cache.revision === this.revision) {
      return this.cache;
    }
    this.lastWidth = w;

    const rows = [];
    const markers = [];
    for (const frame of this.frames) {
      markers.push({ id: frame.id, kind: frame.kind, row: rows.length, meta: frame.meta, ts: frame.ts });
      const produced = this.renderFrame(frame, w);
      for (const row of produced) rows.push(row);
    }

    this.cache = { width: w, revision: this.revision, rows, markers };
    return this.cache;
  }

  rows(width) {
    return this.flatten(width).rows;
  }

  /**
   * Frame start rows — what the rail draws and what [ / ] jump between.
   */
  markers(width) {
    return this.flatten(width).markers;
  }

  height(width) {
    return this.flatten(width).rows.length;
  }

  /**
   * A window of rows, clamped. The viewport asks for exactly what it can show.
   */
  slice(width, start, count) {
    const rows = this.flatten(width).rows;
    const from = Math.max(0, Math.min(Math.floor(start) || 0, rows.length));
    return rows.slice(from, from + Math.max(0, Math.floor(count) || 0));
  }

  /**
   * Everything, for print-through on exit.
   *
   * This is the half opencode cannot have in either mode: its alternate-screen
   * TUI leaves nothing behind, and its split-footer mode leaves everything but
   * cannot scroll. Flushing the model on the way out gives both.
   */
  snapshot(width) {
    return this.flatten(width).rows.slice();
  }

  clear() {
    this.frames = [];
    this.cache = null;
    this.revision++;
    this.changed();
  }
}
