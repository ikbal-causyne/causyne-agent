// Travelling running-light shimmer animation for Causyne Agent TUI.
//
// Implements a width-stable, multi-stop chromatic highlight wave that sweeps
// across active status labels ("working...", "Analyzing & planning…") and
// live streaming reasoning lines ("thinking…", "analyzing…", and active tail
// thoughts).
//
// Mathematical model:
//   - Window width W = min(L, 5), where L is the code-point length.
//   - Short strings (L < 25): unidirectional left-to-right sweep at 80ms/step
//     with a 3-step lead-in and 3-step lead-out dead-zone.
//   - Long strings (L >= 25): bidirectional ping-pong sweep at 40ms/step
//     with smooth lead-in/lead-out turnarounds.
//
// Invariant:
//   - Strictly preserves character sequence and terminal column width:
//     stripAnsi(renderRunningLight(s)) === stripAnsi(s)
//     visibleWidth(renderRunningLight(s)) === visibleWidth(s)
//
// Pure TypeScript under strict mode.
// @ts-expect-error theme.js has no TypeScript declaration yet.
import { paint, bold, dim, HAS_COLOR, COLOR_DEPTH, IS_LIGHT } from './theme.js';
import { stripAnsi } from './text.js';
const DARK_TRUECOLOR_STOPS = [
    '\x1b[38;2;154;186;104m', // 0: outer shoulder (#9aba68)
    '\x1b[38;2;182;224;111m', // 1: Signal Lime (#b6e06f)
    '\x1b[1m\x1b[38;2;232;248;204m', // 2: luminous specular crest (#e8f8cc)
    '\x1b[38;2;182;224;111m', // 3: Signal Lime (#b6e06f)
    '\x1b[38;2;154;186;104m', // 4: outer shoulder (#9aba68)
];
const LIGHT_TRUECOLOR_STOPS = [
    '\x1b[38;2;92;124;42m', // 0: outer shoulder (#5c7c2a)
    '\x1b[38;2;78;112;24m', // 1: deep Signal Lime (#4e7018)
    '\x1b[1m\x1b[38;2;38;64;4m', // 2: high-contrast crest (#264004)
    '\x1b[38;2;78;112;24m', // 3: deep Signal Lime (#4e7018)
    '\x1b[38;2;92;124;42m', // 4: outer shoulder (#5c7c2a)
];
const DARK_256_STOPS = [
    '\x1b[38;5;107m',
    '\x1b[38;5;149m',
    '\x1b[1m\x1b[38;5;193m',
    '\x1b[38;5;149m',
    '\x1b[38;5;107m',
];
const LIGHT_256_STOPS = [
    '\x1b[38;5;64m',
    '\x1b[38;5;28m',
    '\x1b[1m\x1b[38;5;22m',
    '\x1b[38;5;28m',
    '\x1b[38;5;64m',
];
const RESET = '\x1b[0m';
/**
 * Resolves the step duration in milliseconds for short (< 25 chars) and
 * long (>= 25 chars) strings.
 */
export function resolveRunningLightSpeed(speed = 'medium') {
    switch (speed) {
        case 'off':
            return { shortStepMs: 0, longStepMs: 0 };
        case 'slow':
            return { shortStepMs: 200, longStepMs: 100 };
        case 'fast':
            return { shortStepMs: 20, longStepMs: 10 };
        case 'medium':
        default:
            return { shortStepMs: 80, longStepMs: 40 };
    }
}
/**
 * Computes the active highlight window [start, start + width) at timestamp `nowMs`.
 *
 * - For `runesLen < 25`: unidirectional left-to-right sweep at `shortStepMs`.
 * - For `runesLen >= 25`: bidirectional ping-pong sweep at `longStepMs`.
 */
export function runningLightWindow(runesLen, nowMs, speed = 'medium') {
    const len = Math.max(0, Math.floor(runesLen));
    const { shortStepMs, longStepMs } = resolveRunningLightSpeed(speed);
    if (len <= 0 || shortStepMs <= 0 || longStepMs <= 0) {
        return { start: 0, width: 0, active: false };
    }
    const t = Math.max(0, Math.floor(Number.isFinite(nowMs) ? nowMs : 0));
    const windowWidth = Math.min(len, 5);
    const span = len + windowWidth;
    const limit = span + 6;
    if (len < 25) {
        const step = Math.floor(t / shortStepMs);
        const phase = ((step % limit) + limit) % limit;
        const pos = phase - windowWidth;
        const start = pos - 3;
        return { start, width: windowWidth, active: true };
    }
    const halfPeriod = span + 5;
    const fullPeriod = halfPeriod * 2;
    const step = Math.floor(t / longStepMs);
    const phase = ((step % fullPeriod) + fullPeriod) % fullPeriod;
    const folded = phase < limit ? phase : fullPeriod - phase;
    const pos = folded - windowWidth;
    const start = pos - 3;
    return { start, width: windowWidth, active: true };
}
/**
 * Maps a character offset [0 .. windowWidth - 1] inside the highlight window
 * to one of the 5 chromatic gradient stops [0 .. 4].
 */
function mapWindowOffsetToStop(offset, windowWidth) {
    if (windowWidth <= 1)
        return 2;
    if (windowWidth >= 5) {
        const clamped = Math.max(0, Math.min(4, offset));
        return clamped;
    }
    const scaled = Math.floor((offset * 5) / windowWidth);
    const clamped = Math.max(0, Math.min(4, scaled));
    return clamped;
}
function paintBaseSegment(segment, baseRole, boldActive) {
    if (!segment)
        return '';
    if (baseRole === 'dim')
        return dim(segment);
    const painted = paint(baseRole, segment);
    return boldActive && baseRole === 'warn' ? bold(painted) : painted;
}
function paintStopSegment(segment, stop, boldActive) {
    if (!segment)
        return '';
    if (!HAS_COLOR || COLOR_DEPTH <= 1)
        return segment;
    if (COLOR_DEPTH >= 16777216) {
        const palette = IS_LIGHT ? LIGHT_TRUECOLOR_STOPS : DARK_TRUECOLOR_STOPS;
        const prefix = palette[stop];
        const boldPrefix = boldActive && stop !== 2 ? '\x1b[1m' : '';
        return `${boldPrefix}${prefix}${segment}${RESET}`;
    }
    if (COLOR_DEPTH >= 256) {
        const palette = IS_LIGHT ? LIGHT_256_STOPS : DARK_256_STOPS;
        const prefix = palette[stop];
        const boldPrefix = boldActive && stop !== 2 ? '\x1b[1m' : '';
        return `${boldPrefix}${prefix}${segment}${RESET}`;
    }
    // 16-color fallback
    if (stop === 2) {
        return bold(paint('ink', segment));
    }
    return boldActive || stop === 1 || stop === 3
        ? bold(paint('accent', segment))
        : paint('accent', segment);
}
/**
 * Renders `text` with a travelling running-light shimmer highlight at the
 * current timestamp or tick.
 *
 * Strictly width-stable: never adds or removes characters.
 */
export function renderRunningLight(text, options = {}) {
    const plain = stripAnsi(String(text ?? ''));
    if (!plain)
        return '';
    const baseRole = options.baseRole ?? 'muted';
    const boldActive = Boolean(options.boldActive);
    const speed = options.speed ?? 'medium';
    if (!HAS_COLOR || COLOR_DEPTH <= 1 || speed === 'off') {
        return HAS_COLOR ? paintBaseSegment(plain, baseRole, boldActive) : plain;
    }
    const chars = Array.from(plain);
    const len = chars.length;
    const nowMs = options.nowMs !== undefined
        ? options.nowMs
        : options.tick !== undefined
            ? options.tick * 80
            : 0;
    const win = runningLightWindow(len, nowMs, speed);
    if (!win.active || win.width <= 0) {
        return paintBaseSegment(plain, baseRole, boldActive);
    }
    const windowEnd = win.start + win.width;
    // Fast path: when the highlight window is completely in the lead-in or
    // lead-out dead-zone outside [0, len), paint the entire string in one pass.
    if (windowEnd <= 0 || win.start >= len) {
        return paintBaseSegment(plain, baseRole, boldActive);
    }
    // Coalesce consecutive characters with the same style index (-1 = base, 0..4 = stop)
    let out = '';
    let currentStyle = -2;
    let currentRun = '';
    const flushRun = (style, run) => {
        if (!run)
            return;
        if (style < 0) {
            out += paintBaseSegment(run, baseRole, boldActive);
        }
        else {
            out += paintStopSegment(run, style, boldActive);
        }
    };
    for (let i = 0; i < len; i++) {
        const ch = chars[i];
        const style = (i >= win.start && i < windowEnd)
            ? mapWindowOffsetToStop(i - win.start, win.width)
            : -1;
        if (style !== currentStyle) {
            flushRun(currentStyle, currentRun);
            currentStyle = style;
            currentRun = ch;
        }
        else {
            currentRun += ch;
        }
    }
    flushRun(currentStyle, currentRun);
    return out;
}
