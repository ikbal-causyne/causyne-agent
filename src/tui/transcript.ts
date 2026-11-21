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
export const KINDS: readonly string[] = Object.freeze([
  'session', 'user', 'assistant', 'reasoning', 'plan', 'step', 'result',
  'approval', 'notice', 'error', 'skill', 'turn', 'checkpoint'
]);

export type FrameProducer = (width: number) => unknown[];

export interface TranscriptFrame {
  id: number;
  kind: string;
  ts: number;
  meta: Record<string, unknown> | null;
  produce: FrameProducer;
  rows: string[] | null;
  renderedWidth: number;
}

export interface TranscriptMarker {
  id: number;
  kind: string;
  row: number;
  meta: Record<string, unknown> | null;
  ts: number;
}

export interface TranscriptFlattened {
  width: number;
  revision: number;
  rows: string[];
  markers: TranscriptMarker[];
}

export interface TranscriptOptions {
  maxFrames?: number;
  onEvict?: ((rows: string[], frame: TranscriptFrame) => void) | null;
  onChange?: ((transcript: Transcript) => void) | null;
}

export interface TranscriptAppendOptions {
  kind?: string;
  produce?: FrameProducer;
  meta?: Record<string, unknown> | null;
}

function normalizeRows(produced: unknown): string[] {
  if (!Array.isArray(produced)) return [];
  const rows: string[] = [];
  for (const row of produced) {
    const text = (row == null ? '' : String(row)).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    // A frame may never contain a newline or carriage return: the Stage paints
    // with relative cursor motion only, and an embedded '\n' or '\r' corrupts
    // the terminal band. Split cleanly rather than drop, so nothing is lost.
    if (text.includes('\n')) rows.push(...text.split('\n'));
    else rows.push(text);
  }
  return rows;
}

export class Transcript {
  frames: TranscriptFrame[];
  maxFrames: number;
  onEvict: ((rows: string[], frame: TranscriptFrame) => void) | null;
  onChange: ((transcript: Transcript) => void) | null;
  nextId: number;
  revision: number;
  evictedFrames: number;
  evictedRows: number;
  cache: TranscriptFlattened | null;
  lastWidth: number;
  surface?: any;

  constructor(options: TranscriptOptions = {}) {
    const { maxFrames = MAX_FRAMES, onEvict = null, onChange = null } =
      options && typeof options === 'object' ? options : {};
    this.frames = [];
    this.maxFrames = Number.isFinite(maxFrames) ? Math.max(1, Math.floor(maxFrames)) : MAX_FRAMES;
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

  get length(): number {
    return this.frames.length;
  }

  isEmpty(): boolean {
    return this.frames.length === 0;
  }

  /**
   * Append one frame.
   *
   * `produce` is called lazily and may be called again at a different width.
   * It must not mutate anything the caller will read later.
   */
  append(options: TranscriptAppendOptions = {}): number | null {
    const { kind = 'notice', produce, meta = null } =
      options && typeof options === 'object' ? options : {};
    if (typeof produce !== 'function') return null;
    const frame: TranscriptFrame = {
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
  replaceTail(options: TranscriptAppendOptions = {}): number | null {
    const { kind, produce, meta } =
      options && typeof options === 'object' ? options : {};
    const frame = this.frames[this.frames.length - 1];
    if (!frame || typeof produce !== 'function') {
      const appendOpts: TranscriptAppendOptions = {};
      if (kind !== undefined) appendOpts.kind = kind;
      if (produce !== undefined) appendOpts.produce = produce;
      if (meta !== undefined) appendOpts.meta = meta;
      return this.append(appendOpts);
    }
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

  /**
   * Batch multiple appends or frame updates under a single change event,
   * preventing O(N^2) reflows during session history restoration.
   */
  batch(action: () => void): void {
    if (typeof action !== 'function') return;
    const prevOnChange = this.onChange;
    this.onChange = null;
    try {
      action();
    } finally {
      this.onChange = prevOnChange;
      this.changed();
    }
  }

  changed(): void {
    if (!this.onChange) return;
    // A listener that throws must not take the transcript down with it: the
    // model is the session's memory and a repaint is only a picture of it.
    try { this.onChange(this); } catch { /* the surface will catch up next frame */ }
  }

  evictOverflow(): void {
    while (this.frames.length > this.maxFrames) {
      const frame = this.frames.shift();
      if (!frame) break;
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

  renderFrame(frame: TranscriptFrame, width: number): string[] {
    if (frame.rows && frame.renderedWidth === width) return frame.rows;
    let produced: unknown[] = [];
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
  flatten(width?: number): TranscriptFlattened {
    const w = typeof width === 'number' && Number.isFinite(width) && width > 0 ? Math.max(1, Math.floor(width)) : this.lastWidth;
    if (this.cache && this.cache.width === w && this.cache.revision === this.revision) {
      return this.cache;
    }
    this.lastWidth = w;

    const rows: string[] = [];
    const markers: TranscriptMarker[] = [];
    for (const frame of this.frames) {
      markers.push({ id: frame.id, kind: frame.kind, row: rows.length, meta: frame.meta, ts: frame.ts });
      const produced = this.renderFrame(frame, w);
      for (const row of produced) rows.push(row);
    }

    this.cache = { width: w, revision: this.revision, rows, markers };
    return this.cache;
  }

  rows(width?: number): string[] {
    return this.flatten(width).rows;
  }

  /**
   * Frame start rows — what the rail draws and what [ / ] jump between.
   */
  markers(width?: number): TranscriptMarker[] {
    return this.flatten(width).markers;
  }

  height(width?: number): number {
    return this.flatten(width).rows.length;
  }

  /**
   * A window of rows, clamped. The viewport asks for exactly what it can show.
   */
  slice(width: number, start: number, count: number): string[] {
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
  snapshot(width?: number): string[] {
    return this.flatten(width).rows.slice();
  }

  clear(): void {
    this.frames = [];
    this.cache = null;
    this.revision++;
    this.changed();
  }
}
