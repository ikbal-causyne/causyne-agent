// The scroll/follow state machine over a Transcript.
//
// This behavior is specified by the viewport contract: the wheel and the keyboard move
// the box, the terminal does not scroll, and while a task runs the view
// auto-scrolls — until you scroll up, at which point it stops and lets the
// content grow underneath you.
//
// THE ONE ALGORITHM WORTH PORTING VERBATIM, and the reason to port it rather
// than write the obvious version:
//
// The obvious version sets a "user scrolled away" flag when the user presses a
// key or turns the wheel. That is wrong in both directions — a programmatic
// scroll looks like user intent, and returning to the bottom by wheel does not
// clear it. @opentui/core's ScrollBox (ScrollBox.ts:224-242) instead DERIVES the
// flag from position on every scroll mutation:
//
//     hasManualScroll = hasScrollableContent && !isAtStickyPosition()
//
// with a reentrancy guard around the auto-follow's own writes, so the follow
// logic cannot mistake itself for the user. Any scroll that leaves the bottom
// edge sets it; any scroll that lands on the bottom edge clears it; nobody has
// to enumerate the ways a scroll can happen. Re-engagement has a one-row
// tolerance (ScrollBox.ts:497-512), which is what makes "scroll back down and
// it starts following again" feel forgiving instead of pixel-precise.
//
// Wheel deltas: the wire always reports 1 (lib/parse.mouse.ts:166-171), so all
// speed lives here. Three rows per notch is opencode's default and it is
// genuinely the right number. The fractional accumulator is what allows a
// non-integer speed without drifting.
//
// Pure JS. No dependency, no shell.

// Rows per wheel notch. opencode's default, and its acceleration is opt-in for
// good reason: an accelerating wheel in a transcript overshoots the thing you
// were trying to read.
export const DEFAULT_SCROLL_SPEED = 3;

/**
 * Opt-in wheel acceleration, the same shape opencode uses.
 *
 * (`@opentui/core` `lib/scroll-acceleration.ts:34-97`.) A streak of notches
 * arriving close together multiplies the distance; a gap resets it. It stays
 * OPT-IN because an accelerating wheel in a transcript overshoots the thing you
 * were trying to read, which is worse than a wheel that is merely slow.
 *
 * `minTickInterval` is not a nicety: some terminals emit a wheel notch twice in
 * the same few milliseconds, and counting both makes the curve run away.
 */
export class ScrollAcceleration {
  constructor({ history = 3, streakTimeout = 150, minTickInterval = 6 } = {}) {
    this.historySize = history;
    this.streakTimeout = streakTimeout;
    this.minTickInterval = minTickInterval;
    this.intervals = [];
    this.lastTick = 0;
  }

  reset() {
    this.intervals = [];
    this.lastTick = 0;
  }

  tick(now = Date.now()) {
    const A = 0.8;
    const tau = 3;
    const maxMultiplier = 6;

    const gap = this.lastTick ? now - this.lastTick : Infinity;
    if (gap === Infinity || gap > this.streakTimeout) {
      this.lastTick = now;
      this.intervals = [];
      return 1;
    }
    if (gap < this.minTickInterval) return 1;

    this.lastTick = now;
    this.intervals.push(gap);
    if (this.intervals.length > this.historySize) this.intervals.shift();

    const average = this.intervals.reduce((sum, v) => sum + v, 0) / this.intervals.length;
    const velocity = 100 / average;
    return Math.min(1 + A * (Math.exp(velocity / tau) - 1), maxMultiplier);
  }
}

// How close to the bottom counts as "back at the bottom" for the purposes of
// resuming follow.
const REENGAGE_TOLERANCE = 1;

export class Viewport {
  constructor({ transcript, height = 20, width = 80, speed = DEFAULT_SCROLL_SPEED, acceleration = null } = {}) {
    this.transcript = transcript;
    this.viewHeight = Math.max(1, Math.floor(height));
    this.viewWidth = Math.max(1, Math.floor(width));
    this.speed = speed > 0 ? speed : DEFAULT_SCROLL_SPEED;
    // null means a flat speed, which is the default and the right one.
    this.acceleration = acceleration || null;

    this.scrollTop = 0;
    // Derived, never assigned from an event. See the header.
    this.manual = false;
    this.applyingSticky = false;
    this.accumulator = 0;
    // Rows that arrived while the user was reading somewhere else.
    this.unseen = 0;
  }

  get height() { return this.viewHeight; }
  get width() { return this.viewWidth; }

  /**
   * Geometry changed — a resize, or the input box growing under the viewport.
   *
   * Resizing must not silently unfollow: growing the viewport reduces
   * maxScrollTop, which would leave scrollTop above it and read as "the user
   * scrolled away". refresh() re-derives from the new geometry instead.
   */
  resize({ height, width } = {}) {
    if (Number.isFinite(height) && height > 0) this.viewHeight = Math.floor(height);
    if (Number.isFinite(width) && width > 0) this.viewWidth = Math.floor(width);
    this.refresh();
  }

  contentHeight() {
    return this.transcript ? this.transcript.height(this.viewWidth) : 0;
  }

  maxScrollTop() {
    return Math.max(0, this.contentHeight() - this.viewHeight);
  }

  /**
   * Is there enough content for scrolling to mean anything?
   *
   * The `> 1` rather than `> 0` is deliberate and comes from the reference: one
   * row of overflow is not a scroll, and treating it as one makes the follow
   * flag flicker on every wrapped line during streaming.
   */
  scrollable() {
    return this.maxScrollTop() > 1;
  }

  atBottom() {
    return this.scrollTop >= this.maxScrollTop();
  }

  get following() {
    return !this.manual;
  }

  /**
   * Re-derive the follow flag from where we now are. Called after EVERY scroll
   * mutation, whoever caused it.
   */
  sync() {
    if (this.applyingSticky) {
      // A move we made ourselves. It is only allowed to CLEAR the flag — by
      // arriving back at the bottom — never to set it.
      if (this.manual && this.scrollable() && this.atBottom()) {
        this.manual = false;
        this.unseen = 0;
      }
      return;
    }
    this.manual = this.scrollable() && !this.atBottom();
    if (!this.manual) this.unseen = 0;
  }

  /**
   * The content changed height — a token arrived, a tool printed, a frame was
   * evicted. This is where auto-scroll actually happens.
   */
  refresh(grownBy = 0) {
    const wasApplying = this.applyingSticky;
    this.applyingSticky = true;
    try {
      const max = this.maxScrollTop();

      // The tolerance applies to GROWTH only, and this is where Causyne departs
      // from the reference on purpose.
      //
      // opencode applies it on any size change (ScrollBox.ts:766-774), and
      // refresh() runs here on every frame because the viewport is re-measured
      // whenever the input box changes height. With a flat tolerance, scrolling
      // up exactly one row leaves scrollTop at max - 1, and the very next
      // keystroke re-engages and snaps it back — so a one-line scroll is a key
      // that visibly does nothing. "You came back to the bottom while content
      // was streaming" is a statement about growth; without growth, the bottom
      // means the bottom.
      const tolerance = grownBy > 0 ? REENGAGE_TOLERANCE : 0;

      if (!this.manual) {
        this.scrollTop = max;
        this.unseen = 0;
      } else if (max > 0 && this.scrollTop >= max - tolerance) {
        // The user came back to the bottom while content was streaming.
        this.manual = false;
        this.scrollTop = max;
        this.unseen = 0;
      } else {
        // Reading somewhere else: hold position, but never let a shrinking
        // transcript strand the view past the end of it.
        this.scrollTop = Math.min(this.scrollTop, max);
        if (grownBy > 0) this.unseen += grownBy;
      }
    } finally {
      this.applyingSticky = wasApplying;
    }
  }

  scrollTo(position, { snap = false } = {}) {
    const max = this.maxScrollTop();
    let next = Math.max(0, Math.min(Math.round(position), max));

    // THE TOLERANCE BELONGS TO DOWNWARD MOTION, not to the repaint.
    //
    // The reference puts it in the growth handler (ScrollBox.ts:497-512), where
    // it covers the case that actually annoys people: a wheel of three rows per
    // notch lands you one row short of the bottom, and follow never resumes.
    // But that handler runs on every repaint here, so a flat tolerance also
    // undoes a deliberate one-row scroll UP — a key that visibly does nothing.
    //
    // The two are mechanically identical and differ only in intent, and the
    // direction of travel is the one piece of intent that IS available. So the
    // snap is applied to downward motion only: scrolling down to within a row
    // of the end means the end; scrolling up by one row means one row.
    if (snap && next > this.scrollTop && max - next <= REENGAGE_TOLERANCE) next = max;

    if (next !== this.scrollTop) this.scrollTop = next;
    this.sync();
    return this.scrollTop;
  }

  scrollBy(delta) {
    return this.scrollTo(this.scrollTop + delta, { snap: delta > 0 });
  }

  /**
   * One wheel notch. `direction` is 'up' or 'down'.
   *
   * The accumulator carries the fraction so a speed of, say, 1.5 does not
   * quietly round to 1 or 2 forever.
   */
  wheel(direction, notches = 1, now = Date.now()) {
    const before = this.scrollTop;
    const multiplier = this.acceleration ? this.acceleration.tick(now) : 1;
    const amount = Math.abs(notches) * this.speed * multiplier;
    this.accumulator += direction === 'up' ? -amount : amount;
    const whole = Math.trunc(this.accumulator);
    if (whole !== 0) {
      this.accumulator -= whole;
      this.scrollBy(whole);
    }
    // `moved` is what lets the caller tell "scrolled" from "already at the
    // end". Without it the wheel was swallowed unconditionally, so reaching the
    // top of the band meant the terminal's own scrollback — which holds the
    // rest of the conversation — could not be reached by wheel at all.
    this.lastWheelMoved = this.scrollTop !== before;
    return this.scrollTop;
  }

  // A page keeps one row of overlap, which is what every pager does and what
  // lets the eye carry across the jump. (opencode calls height/2 a "page" and
  // height/4 a "half page"; both are half of what their names claim, and there
  // is no reason to inherit that.)
  pageUp() { return this.scrollBy(-Math.max(1, this.viewHeight - 1)); }
  pageDown() { return this.scrollBy(Math.max(1, this.viewHeight - 1)); }
  halfPageUp() { return this.scrollBy(-Math.max(1, Math.floor(this.viewHeight / 2))); }
  halfPageDown() { return this.scrollBy(Math.max(1, Math.floor(this.viewHeight / 2))); }
  lineUp(n = 1) { return this.scrollBy(-n); }
  lineDown(n = 1) { return this.scrollBy(n); }
  toTop() { return this.scrollTo(0); }

  /**
   * Jump to the bottom and resume following.
   *
   * scrollTo() alone would land at the bottom and sync() would clear the flag,
   * but only if the content is scrollable; going through the sticky path makes
   * "follow again" unconditional, which is what the user means by pressing it.
   */
  toBottom() {
    this.manual = false;
    this.unseen = 0;
    this.refresh();
    return this.scrollTop;
  }

  /**
   * Frame boundaries, for step-to-step and turn-to-turn jumps.
   */
  jump(direction, kinds = null) {
    if (!this.transcript) return this.scrollTop;
    const markers = this.transcript.markers(this.viewWidth)
      .filter((m) => !kinds || kinds.includes(m.kind));
    if (markers.length === 0) return this.scrollTop;

    if (direction < 0) {
      const previous = markers.filter((m) => m.row < this.scrollTop).pop();
      return this.scrollTo(previous ? previous.row : 0);
    }
    const next = markers.find((m) => m.row > this.scrollTop);
    return next ? this.scrollTo(next.row) : this.toBottom();
  }

  /**
   * The rows on screen, top-aligned and padded to the full height.
   *
   * Top-aligned because that is what the reference does: content starts at the
   * top of the box and the gap sits above the prompt, not below the first
   * message.
   */
  rows() {
    const window = this.transcript
      ? this.transcript.slice(this.viewWidth, this.scrollTop, this.viewHeight)
      : [];
    const out = window.slice(0, this.viewHeight);
    while (out.length < this.viewHeight) out.push('');
    return out;
  }

  /**
   * Where we are, for the rail and the "N new below" affordance.
   */
  state() {
    const max = this.maxScrollTop();
    return {
      scrollTop: this.scrollTop,
      max,
      height: this.viewHeight,
      contentHeight: this.contentHeight(),
      following: this.following,
      unseen: this.unseen,
      // 0..1, or null when there is nothing to scroll.
      progress: max > 0 ? this.scrollTop / max : null
    };
  }
}
