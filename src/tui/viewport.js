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
// Pure TypeScript. No dependency, no shell.
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
    historySize;
    streakTimeout;
    minTickInterval;
    intervals;
    lastTick;
    constructor({ history = 3, streakTimeout = 150, minTickInterval = 6 } = {}) {
        this.historySize = Number.isFinite(history) ? Math.max(0, Math.floor(history)) : 3;
        this.streakTimeout = Number.isFinite(streakTimeout) && streakTimeout >= 0 ? streakTimeout : 150;
        this.minTickInterval = Number.isFinite(minTickInterval) && minTickInterval >= 0 ? minTickInterval : 6;
        this.intervals = [];
        this.lastTick = 0;
    }
    reset() {
        this.intervals = [];
        this.lastTick = 0;
    }
    tick(now = Date.now()) {
        if (!Number.isFinite(now))
            return 1;
        const A = 0.8;
        const tau = 3;
        const maxMultiplier = 6;
        const gap = this.lastTick ? now - this.lastTick : Infinity;
        if (gap === Infinity || gap > this.streakTimeout) {
            this.lastTick = now;
            this.intervals = [];
            return 1;
        }
        if (gap < Math.max(0, this.minTickInterval))
            return 1;
        this.lastTick = now;
        if (this.historySize > 0) {
            this.intervals.push(gap);
            while (this.intervals.length > this.historySize)
                this.intervals.shift();
        }
        if (this.intervals.length === 0)
            return 1;
        const average = this.intervals.reduce((sum, v) => sum + v, 0) / this.intervals.length;
        const velocity = 100 / average;
        return Math.min(1 + A * (Math.exp(velocity / tau) - 1), maxMultiplier);
    }
}
// How close to the bottom counts as "back at the bottom" for the purposes of
// resuming follow.
const REENGAGE_TOLERANCE = 1;
import { captureReadingAnchor, restoreReadingAnchor } from './viewportAnchor.js';
export class Viewport {
    transcript;
    viewHeight;
    viewWidth;
    speed;
    acceleration;
    scrollTop;
    manual;
    applyingSticky;
    accumulator;
    unseen;
    lastWheelMoved;
    lastWheelDirection;
    constructor({ transcript = null, height = 20, width = 80, speed = DEFAULT_SCROLL_SPEED, acceleration = null } = {}) {
        this.transcript = transcript;
        this.viewHeight = Number.isFinite(height) ? Math.max(1, Math.floor(height)) : 20;
        this.viewWidth = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 80;
        this.speed = Number.isFinite(speed) && speed > 0 ? speed : DEFAULT_SCROLL_SPEED;
        this.acceleration = acceleration || null;
        this.scrollTop = 0;
        this.manual = false;
        this.applyingSticky = false;
        this.accumulator = 0;
        this.unseen = 0;
        this.lastWheelMoved = false;
        this.lastWheelDirection = null;
    }
    get height() { return this.viewHeight; }
    get width() { return this.viewWidth; }
    /**
     * Geometry changed — a resize, or the input box growing under the viewport.
     */
    resize({ height, width } = {}) {
        const nextHeight = height !== undefined && Number.isFinite(height) && height > 0
            ? Math.max(1, Math.floor(height)) : this.viewHeight;
        const nextWidth = width !== undefined && Number.isFinite(width) && width > 0
            ? Math.max(1, Math.floor(width)) : this.viewWidth;
        const reflow = nextWidth !== this.viewWidth;
        const anchor = reflow && this.manual && this.transcript?.markers
            ? captureReadingAnchor(this.transcript.markers(this.viewWidth), this.scrollTop, this.transcript.height(this.viewWidth)) : null;
        this.viewHeight = nextHeight;
        this.viewWidth = nextWidth;
        if (anchor && this.transcript?.markers) {
            this.scrollTop = restoreReadingAnchor(anchor, this.transcript.markers(nextWidth), this.transcript.height(nextWidth), nextHeight);
            const max = this.maxScrollTop();
            // A deliberate scroll must not suddenly become follow-mode just because
            // a paragraph gained or lost wrapped rows during resize.
            this.manual = max > 0 && this.scrollTop < max;
            if (!this.manual)
                this.unseen = 0;
            return;
        }
        this.refresh();
    }
    contentHeight() {
        const measured = this.transcript ? this.transcript.height(this.viewWidth) : 0;
        return Number.isFinite(measured) ? Math.max(0, Math.floor(measured)) : 0;
    }
    maxScrollTop() {
        return Math.max(0, this.contentHeight() - this.viewHeight);
    }
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
            if (this.manual && this.scrollable() && this.atBottom()) {
                this.manual = false;
                this.unseen = 0;
            }
            return;
        }
        this.manual = this.scrollable() && !this.atBottom();
        if (!this.manual)
            this.unseen = 0;
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
            const tolerance = grownBy > 0 ? REENGAGE_TOLERANCE : 0;
            if (!this.manual) {
                this.scrollTop = max;
                this.unseen = 0;
            }
            else if (max > 0 && this.scrollTop >= max - tolerance) {
                this.manual = false;
                this.scrollTop = max;
                this.unseen = 0;
            }
            else {
                this.scrollTop = Math.min(this.scrollTop, max);
                if (grownBy > 0)
                    this.unseen += grownBy;
            }
        }
        finally {
            this.applyingSticky = wasApplying;
        }
    }
    scrollTo(position, { snap = false } = {}) {
        if (!Number.isFinite(position))
            return this.scrollTop;
        const max = this.maxScrollTop();
        let next = Math.max(0, Math.min(Math.round(position), max));
        if (snap && next > this.scrollTop && max - next <= REENGAGE_TOLERANCE)
            next = max;
        if (next !== this.scrollTop)
            this.scrollTop = next;
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
        if (!Number.isFinite(notches) || !Number.isFinite(now)) {
            this.lastWheelMoved = false;
            return this.scrollTop;
        }
        const before = this.scrollTop;
        if (this.lastWheelDirection && this.lastWheelDirection !== direction) {
            this.accumulator = 0;
        }
        this.lastWheelDirection = direction;
        const multiplier = this.acceleration ? this.acceleration.tick(now) : 1;
        const amount = Math.abs(notches) * this.speed * multiplier;
        if (!Number.isFinite(amount)) {
            this.lastWheelMoved = false;
            return this.scrollTop;
        }
        this.accumulator += direction === 'up' ? -amount : amount;
        const whole = Math.trunc(this.accumulator);
        if (whole !== 0) {
            this.accumulator -= whole;
            this.scrollBy(whole);
        }
        this.lastWheelMoved = this.scrollTop !== before;
        return this.scrollTop;
    }
    pageUp() { return this.scrollBy(-Math.max(1, this.viewHeight - 1)); }
    pageDown() { return this.scrollBy(Math.max(1, this.viewHeight - 1)); }
    halfPageUp() { return this.scrollBy(-Math.max(1, Math.floor(this.viewHeight / 2))); }
    halfPageDown() { return this.scrollBy(Math.max(1, Math.floor(this.viewHeight / 2))); }
    lineUp(n = 1) { return this.scrollBy(-n); }
    lineDown(n = 1) { return this.scrollBy(n); }
    toTop() { return this.scrollTo(0); }
    toBottom() {
        this.manual = false;
        this.unseen = 0;
        this.refresh();
        return this.scrollTop;
    }
    jump(direction, kinds = null) {
        if (!this.transcript || typeof this.transcript.markers !== 'function')
            return this.scrollTop;
        const markers = this.transcript.markers(this.viewWidth)
            .filter((m) => !kinds || kinds.includes(m.kind));
        if (markers.length === 0)
            return this.scrollTop;
        if (direction < 0) {
            const previous = markers.filter((m) => m.row < this.scrollTop).pop();
            return this.scrollTo(previous ? previous.row : 0);
        }
        const next = markers.find((m) => m.row > this.scrollTop);
        return next ? this.scrollTo(next.row) : this.toBottom();
    }
    rows() {
        const window = this.transcript && typeof this.transcript.slice === 'function'
            ? this.transcript.slice(this.viewWidth, this.scrollTop, this.viewHeight)
            : [];
        const out = window.slice(0, this.viewHeight);
        while (out.length < this.viewHeight)
            out.push('');
        return out;
    }
    state() {
        const max = this.maxScrollTop();
        return {
            scrollTop: this.scrollTop,
            max,
            height: this.viewHeight,
            contentHeight: this.contentHeight(),
            following: this.following,
            unseen: this.unseen,
            progress: max > 0 ? this.scrollTop / max : null
        };
    }
}
