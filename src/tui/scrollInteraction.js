// Sovereign TUI Scroll & Mouse Isolation Controller
//
// Implements OpenCode-compliant viewport containment:
// 1. Mouse wheel events are strictly confined to the chat box viewport.
// 2. Overscrolling past the top (0) or bottom (maxScrollTop) saturates cleanly.
// 3. Mouse reporting is NEVER released to the terminal during an active session,
//    preventing terminal scrollback desync and UI freezes.
// 4. Scrollbar (rail) mouse interactions clamp cleanly even if clicked above or
//    below the chat box bounds.
import { sessionMainWidth } from './sessionSidebar.js';
/**
 * Adaptive Wheel Dampener & Momentum Controller.
 *
 * Distinguishes single mechanical mouse wheel notches (e.g. 1 notch every 100ms+)
 * from high-frequency macOS trackpad / Magic Mouse continuous event streams (10-100Hz).
 *
 * For single notches, full discrete step is preserved.
 * For continuous trackpad streams, velocity is smoothly damped via sub-line accumulation
 * so a natural finger swipe advances smoothly without exploding into runaway flight.
 * Direction reversals provide instant braking to prevent momentum drift.
 */
export class AdaptiveWheelDampener {
    minDamping;
    thresholdMs;
    minTickInterval;
    burstWindowMs;
    maxBurstNotches;
    lastTick = null;
    lastDirection = null;
    rowAccumulator = 0;
    recentBursts = [];
    constructor(options = {}) {
        const finiteNonNeg = (value, fallback) => value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
        const rawMinDamping = options.minDamping;
        this.minDamping = rawMinDamping !== undefined && Number.isFinite(rawMinDamping)
            ? Math.min(1, Math.max(0, rawMinDamping))
            : 0.28;
        this.thresholdMs = finiteNonNeg(options.thresholdMs, 85);
        this.minTickInterval = finiteNonNeg(options.minTickInterval, 6);
        this.burstWindowMs = finiteNonNeg(options.burstWindowMs, 120);
        this.maxBurstNotches = finiteNonNeg(options.maxBurstNotches, 5.0);
    }
    /**
     * Compute adaptive fractional notch multiplier for viewports that possess
     * their own sub-row accumulator (e.g. Viewport).
     */
    computeNotches(direction, now = Date.now()) {
        if (!Number.isFinite(now)) {
            return 1.0;
        }
        if (this.lastDirection && this.lastDirection !== direction) {
            this.recentBursts = [];
            this.lastTick = null;
            this.rowAccumulator = 0;
        }
        this.lastDirection = direction;
        const gap = this.lastTick !== null ? Math.max(0, now - this.lastTick) : Infinity;
        this.lastTick = now;
        if (gap === Infinity || gap > 150) {
            this.recentBursts = [];
            return 1.0;
        }
        if (gap < this.minTickInterval) {
            return 1.0;
        }
        const ratio = this.thresholdMs > 0 ? gap / this.thresholdMs : 1.0;
        let damping = Math.max(this.minDamping, Math.min(1.0, ratio));
        const windowStart = now - this.burstWindowMs;
        this.recentBursts = this.recentBursts.filter(b => b.time >= windowStart);
        const windowNotches = this.recentBursts.reduce((sum, b) => sum + b.notches, 0);
        if (windowNotches >= this.maxBurstNotches) {
            damping = Math.min(damping, 0.15);
        }
        this.recentBursts.push({ time: now, notches: damping });
        return damping;
    }
    /**
     * Compute whole integer row steps for widgets without internal sub-row accumulators
     * (e.g. Code panel and Thinking box previews).
     */
    stepRows(direction, baseSpeed = 3, now = Date.now()) {
        if (!Number.isFinite(baseSpeed) || baseSpeed <= 0) {
            return 0;
        }
        const notch = this.computeNotches(direction, now);
        this.rowAccumulator += baseSpeed * notch;
        const whole = Math.trunc(this.rowAccumulator);
        if (whole !== 0) {
            this.rowAccumulator -= whole;
            return whole;
        }
        return 0;
    }
    reset() {
        this.lastTick = null;
        this.lastDirection = null;
        this.rowAccumulator = 0;
        this.recentBursts = [];
    }
}
export const defaultViewportDampener = new AdaptiveWheelDampener();
/**
 * Handle mouse wheel scrolling with full viewport containment.
 * Replaces the buggy overscroll release with clean boundary saturation.
 */
export function handleViewportWheel(key, viewport, surface, host, now = Date.now()) {
    if (!viewport || !key.wheel)
        return true;
    if (key.wheel.direction !== 'up' && key.wheel.direction !== 'down')
        return true;
    // Auto-heal: If the surface was ever detached, immediately re-capture mouse
    // so the session stays responsive and never freezes.
    if (surface && typeof surface.captureMouse === 'function' && surface.detached) {
        surface.captureMouse();
        if (typeof host.notice === 'string' && host.notice.startsWith('top of this view')) {
            host.notice = '';
        }
    }
    // Clear manual turn override on wheel scroll so active indicator syncs with viewport
    if (surface) {
        surface.activeTurnIndex = null;
    }
    const dir = key.wheel.direction === 'down' ? 'down' : 'up';
    const notches = defaultViewportDampener.computeNotches(dir, now);
    viewport.wheel(dir, notches, now);
    // Coalesce redraws to prevent terminal buffer flooding and latency pileup
    if (typeof host.scheduleDraw === 'function') {
        host.scheduleDraw();
    }
    else {
        host.draw();
    }
    return true;
}
/**
 * Handle mouse clicks on the scrollbar rail.
 * Safely clamps coordinates even when clicking above or below the chat box.
 */
export function handleScrollbarMouse(key, viewport, surface, host) {
    if (!viewport || !surface || !key.mouse || !key.mouse.pressed)
        return false;
    if (key.mouse.button !== 0)
        return false; // Left click only
    if (!Number.isFinite(key.mouse.x) || !Number.isFinite(key.mouse.y))
        return false;
    const mouseX = Math.floor(key.mouse.x);
    const mouseY = Math.floor(key.mouse.y);
    const rawTermRows = Number(host.out?.rows);
    const termRows = Number.isFinite(rawTermRows) && rawTermRows > 0 ? Math.floor(rawTermRows) : 24;
    const rawStageH = Number(surface.stage?.height);
    const stageH = Number.isFinite(rawStageH) && rawStageH > 0 ? Math.floor(rawStageH) : termRows;
    // If completion picker is active, check if click was on the picker
    if (host.pickerLayout) {
        const { pickerStart, pickerCount, totalPromptRows } = host.pickerLayout;
        if (Number.isFinite(pickerStart) &&
            Number.isFinite(pickerCount) &&
            Number.isFinite(totalPromptRows) &&
            pickerCount > 0) {
            const promptTop = Math.max(1, stageH - Math.floor(totalPromptRows) + 1);
            const pickerTop = promptTop + Math.floor(pickerStart) - 1;
            const pickerBottom = pickerTop + Math.floor(pickerCount) - 1;
            if (mouseY >= pickerTop && mouseY <= pickerBottom) {
                return false; // Leave to completion handler
            }
        }
    }
    const stageTop = Math.max(0, termRows - stageH);
    const rawViewportH = Number(viewport.height);
    const viewportH = Number.isFinite(rawViewportH) && rawViewportH > 0 ? Math.floor(rawViewportH) : 1;
    const rawStageW = Number(typeof surface.stage?.width === 'function' ? surface.stage.width() : surface.width);
    const stageW = Number.isFinite(rawStageW) && rawStageW > 0 ? Math.floor(rawStageW) : 80;
    const mainW = sessionMainWidth(stageW, Boolean(surface.homeInfo), surface.env);
    const hasRail = typeof surface.railEnabled === 'function' ? surface.railEnabled(mainW) : true;
    if (!hasRail)
        return false;
    const contentW = Math.max(20, mainW - 3);
    // Rail occupies column contentW - 1 through mainW
    const isRailColumn = mouseX >= contentW - 1 && mouseX <= mainW;
    if (isRailColumn) {
        surface.activeTurnIndex = null;
        // Auto-heal if detached
        if (typeof surface.captureMouse === 'function' && surface.detached) {
            surface.captureMouse();
            if (typeof host.notice === 'string' && host.notice.startsWith('top of this view')) {
                host.notice = '';
            }
        }
        // Boundary clamping:
        // Clicks preceding/above chat box clamp to top (0)
        if (mouseY < stageTop) {
            viewport.scrollTo(0);
            host.draw();
            return true;
        }
        // Clicks below viewport clamp to bottom (maxScrollTop) and resume following
        if (mouseY >= stageTop + viewportH) {
            viewport.toBottom();
            host.draw();
            return true;
        }
        // Clicks on rail inside viewport: compute proportional scroll
        const relY = mouseY - stageTop;
        const fraction = viewportH > 1 ? relY / (viewportH - 1) : 0;
        const clampedFraction = Math.max(0, Math.min(1, fraction));
        const rawMax = Number(viewport.maxScrollTop());
        const maxScroll = Number.isFinite(rawMax) && rawMax > 0 ? Math.floor(rawMax) : 0;
        const target = Math.round(clampedFraction * maxScroll);
        if (target >= maxScroll) {
            viewport.toBottom();
        }
        else {
            viewport.scrollTo(target);
        }
        host.draw();
        return true;
    }
    return false;
}
