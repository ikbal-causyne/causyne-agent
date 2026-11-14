/**
 * CausyneRotor.ts
 * Dependency-free, terminal-native animation for a Causyne CLI/TUI.
 * Uses Unicode Braille pixels (2x4 subpixels per character) and ANSI colors.
 * The logo is drawn geometrically, not played from an image/GIF.
 *
 * If an existing TUI (Ink, Blessed, etc.) owns the terminal screen, call
 * renderCausyneRotor(...) in THAT renderer. Do not also start the standalone
 * interval-based renderer.
 */
import { stdout } from 'node:process';
import { safeDisplay } from './text.js';
const BRAILLE_DOTS = [
    [0, 0, 0x01], [0, 1, 0x02], [0, 2, 0x04], [0, 3, 0x40],
    [1, 0, 0x08], [1, 1, 0x10], [1, 2, 0x20], [1, 3, 0x80],
];
const TAU = Math.PI * 2;
const STEP = TAU / 6;
export const COLORS = {
    charcoal: '\x1b[38;2;115;124;137m',
    lime: '\x1b[38;2;181;214;106m',
    outline: '\x1b[38;2;224;230;229m',
    text: '\x1b[38;2;185;192;196m',
    reset: '\x1b[0m',
};
// One triangular blade, defined relative to the hub at (0, 0).
// The remaining five are exact 60-degree rotations of this triangle.
// Negative space between blades forms the central hexagonal aperture.
const BASE_BLADE = [
    { x: -0.86, y: -0.64 },
    { x: 0.06, y: -1.06 },
    { x: -0.42, y: -0.105 },
];
function rotate(p, angle) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
}
function insideTriangle(p, a, b, c) {
    const cross = (v, w, q) => (w.x - v.x) * (q.y - v.y) - (w.y - v.y) * (q.x - v.x);
    const u = cross(a, b, p);
    const v = cross(b, c, p);
    const w = cross(c, a, p);
    return (u >= 0 && v >= 0 && w >= 0) || (u <= 0 && v <= 0 && w <= 0);
}
function distanceToSegment(p, a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSq = dx * dx + dy * dy;
    const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
function smoothstep(t) {
    const x = Math.max(0, Math.min(1, t));
    return x * x * (3 - 2 * x);
}
function clampRotorRange(value, min, max, fallback) {
    const numeric = Number(value ?? fallback);
    return Number.isFinite(numeric) ? Math.max(min, Math.min(max, Math.floor(numeric))) : fallback;
}
export function getAngle(elapsedMs, motion = 'heavy') {
    const t = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
    if (motion === 'smooth')
        return (t / 4200) * TAU;
    if (motion === 'pulse') {
        const cycle = t / 1000;
        return (Math.floor(cycle) + smoothstep(Math.min(1, (cycle % 1) / 0.75))) * STEP;
    }
    // Heavy engine: deliberate acceleration, high-momentum travel, short settle.
    const cycle = t / 860;
    const index = Math.floor(cycle);
    const progress = (cycle % 1) / 0.88; // final 12% holds precisely on an index
    return (index + smoothstep(progress)) * STEP;
}
function sample(p, blades) {
    for (let i = 0; i < 6; i++) {
        const blade = blades[i];
        if (!blade)
            continue;
        const [a, b, c] = blade;
        if (!a || !b || !c || !insideTriangle(p, a, b, c))
            continue;
        // 1.5~2 subpixels: subtle white perimeter like your outlined SVG.
        const edge = Math.min(distanceToSegment(p, a, b), distanceToSegment(p, b, c), distanceToSegment(p, c, a));
        if (edge < 0.018)
            return 3;
        return i === 1 ? 2 : 1;
    }
    return 0;
}
function paint(text, kind, color) {
    if (!color)
        return text;
    const code = kind === 2 ? COLORS.lime : kind === 3 ? COLORS.outline : COLORS.charcoal;
    return code + text + COLORS.reset;
}
/**
 * Returns an ANSI-colored multi-line string. No side effects or timers.
 * Intended for an existing TUI's render() method.
 */
export function renderCausyneRotor(elapsedMs, options = {}) {
    const columns = clampRotorRange(options.columns, 12, 56, 24);
    const rows = clampRotorRange(options.rows, 6, 28, 12);
    const color = options.color ?? true;
    const angle = getAngle(elapsedMs, options.motion ?? 'heavy');
    const blades = Array.from({ length: 6 }, (_, i) => {
        const rotAngle = angle + i * STEP;
        return BASE_BLADE.map((p) => rotate(p, rotAngle));
    });
    const widthDots = columns * 2;
    const heightDots = rows * 4;
    const scale = Math.min(widthDots, heightDots) / 2.42;
    const lines = [];
    for (let row = 0; row < rows; row++) {
        let line = '';
        for (let col = 0; col < columns; col++) {
            let mask = 0;
            let dark = 0;
            let lime = 0;
            let outline = 0;
            for (const [dx, dy, bit] of BRAILLE_DOTS) {
                const px = col * 2 + dx + 0.5;
                const py = row * 4 + dy + 0.5;
                const p = {
                    x: (px - widthDots / 2) / scale,
                    y: (py - heightDots / 2) / scale,
                };
                const hit = sample(p, blades);
                if (!hit)
                    continue;
                mask |= bit;
                if (hit === 1)
                    dark++;
                else if (hit === 2)
                    lime++;
                else
                    outline++;
            }
            if (!mask) {
                line += ' ';
            }
            else {
                // A Braille cell has a single foreground color. Choose the dominant fill.
                const kind = lime > 0 && lime >= dark ? 2 :
                    outline >= 3 && dark === 0 && lime === 0 ? 3 : 1;
                line += paint(String.fromCodePoint(0x2800 + mask), kind, color);
            }
        }
        lines.push(line);
    }
    if (options.label !== '') {
        const cleanLabel = options.label === undefined
            ? 'working'
            : safeDisplay(options.label).replace(/\s+/g, ' ').trim();
        const label = cleanLabel || 'working';
        const status = color
            ? `${COLORS.lime}●${COLORS.reset} ${COLORS.text}${label}${COLORS.reset}`
            : `● ${label}`;
        lines.push(status);
    }
    return lines.join('\n');
}
/**
 * Standalone demo/CLI renderer. It owns its multi-line cursor region.
 * If your app uses Ink/Blessed/another renderer, DO NOT call this function;
 * use renderCausyneRotor() inside the existing renderer instead.
 */
export function startCausyneRotor(options = {}) {
    const color = options.color ?? (Boolean(stdout.isTTY) && !process.env.NO_COLOR && !process.env.CAUSYNE_NO_COLOR);
    if (!stdout.isTTY) {
        const label = options.label === undefined
            ? 'working'
            : safeDisplay(options.label).replace(/\s+/g, ' ').trim();
        stdout.write(label + '\n');
        return { stop() { } };
    }
    const fps = clampRotorRange(options.fps, 4, 30, 16);
    const started = Date.now();
    let stopped = false;
    let lastLines = 0;
    function draw() {
        const frame = renderCausyneRotor(Date.now() - started, { ...options, color });
        const lines = frame.split('\n');
        // Redraw only our reserved lines, never clear the whole terminal.
        if (lastLines > 0)
            stdout.write(`\x1b[${lastLines}A\r`);
        stdout.write(lines.map((line) => `\x1b[2K${line}\n`).join(''));
        lastLines = lines.length;
    }
    stdout.write('\x1b[?25l'); // temporarily hide cursor
    draw();
    const timer = setInterval(draw, Math.round(1000 / fps));
    return {
        stop() {
            if (stopped)
                return;
            stopped = true;
            clearInterval(timer);
            stdout.write('\x1b[?25h'); // restore cursor
        },
    };
}
// ---------------------------------------------------------------------------------------------------------
// Single-Line Status Row / Inline Spinner Integration
// ---------------------------------------------------------------------------------------------------------
/**
 * 2-character Braille rotor frames using the CausyneRotor palette (lime + charcoal).
 * 6-phase rotation corresponding directly to the 60-degree indexed rotor blades.
 */
export const ROTOR_SPINNER_FRAMES = [
    `${COLORS.charcoal}⠇${COLORS.lime}⠙${COLORS.reset}`,
    `${COLORS.charcoal}⠋${COLORS.lime}⠸${COLORS.reset}`,
    `${COLORS.charcoal}⠙${COLORS.lime}⠴${COLORS.reset}`,
    `${COLORS.lime}⠸${COLORS.charcoal}⠦${COLORS.reset}`,
    `${COLORS.lime}⠴${COLORS.charcoal}⠇${COLORS.reset}`,
    `${COLORS.lime}⠦${COLORS.charcoal}⠋${COLORS.reset}`,
];
export const ROTOR_SPINNER_FRAMES_NO_COLOR = [
    '⠇⠙', '⠋⠸', '⠙⠴', '⠸⠦', '⠴⠇', '⠦⠋',
];
export const ROTOR_SPINNER_FRAMES_ASCII = [
    '[-]', '[\\]', '[|]', '[/]',
];
export function getRotorSpinnerFrames(color = true, unicode = true) {
    if (!unicode)
        return ROTOR_SPINNER_FRAMES_ASCII;
    return color ? ROTOR_SPINNER_FRAMES : ROTOR_SPINNER_FRAMES_NO_COLOR;
}
export function getRotorSpinnerFrame(tick, color = true, unicode = true) {
    const frames = getRotorSpinnerFrames(color, unicode);
    const safeTick = Number.isFinite(tick) ? Math.abs(Math.floor(tick)) : 0;
    const index = safeTick % frames.length;
    return frames[index] ?? frames[0] ?? '⠇⠙';
}
const DOT_FRAMES = ['   ', '.  ', '.. ', '...'];
export function getAnimatedDots(tick) {
    const safeTick = Number.isFinite(tick) ? Math.abs(Math.floor(tick)) : 0;
    const stage = Math.floor(safeTick / 2) % DOT_FRAMES.length;
    return DOT_FRAMES[stage] ?? '   ';
}
export function formatAnimatedStatus(message, tick) {
    let base = safeDisplay(message ?? '').replace(/\s+/g, ' ').trimEnd();
    while (base.endsWith('.') || base.endsWith('…')) {
        base = base.slice(0, -1).trimEnd();
    }
    const label = base.trim().length > 0 ? base : 'working';
    return `${label}${getAnimatedDots(tick)}`;
}
