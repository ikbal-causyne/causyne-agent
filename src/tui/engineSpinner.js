/**
 * Canonical Causyne Agent heavy rotating engine and turbine animation.
 *
 * Designed to represent a high-torque mechanical aperture / turbine reactor
 * matching the 6-blade mechanical iris identity from banner.ts. Enforces
 * constant column width across all frames to prevent terminal jitter or layout
 * shifts during streaming turns.
 *
 * Supports truecolor, 256-color, 16-color, NO_COLOR, and 7-bit ASCII fallbacks.
 */
const ESC = '\x1b[';
const RESET = ESC + '0m';
const BOLD = ESC + '1m';
const LIME_RGB = [182, 224, 111];
const BRIGHT_LIME_RGB = [210, 255, 130];
const STEEL_RGB = [95, 102, 114];
const DIM_RGB = [60, 65, 74];
const GLOW_RGB = [135, 165, 90];
const LV = [0, 95, 135, 175, 215, 255];
function rgbTo256(r, g, b) {
    const near = (v) => LV.reduce((bi, x, i) => (Math.abs(x - v) < Math.abs((LV[bi] ?? 0) - v) ? i : bi), 0);
    const ri = near(r);
    const gi = near(g);
    const bi = near(b);
    const cube = 16 + 36 * ri + 6 * gi + bi;
    const gl = Math.max(0, Math.min(23, Math.round(((r + g + b) / 3 - 8) / 10)));
    const gv = 8 + 10 * gl;
    const dc = (r - (LV[ri] ?? 0)) ** 2 + (g - (LV[gi] ?? 0)) ** 2 + (b - (LV[bi] ?? 0)) ** 2;
    const dg = (r - gv) ** 2 + (g - gv) ** 2 + (b - gv) ** 2;
    return dg < dc ? 232 + gl : cube;
}
function fgAnsi(rgb, mode, bold = false) {
    if (mode === 'none')
        return '';
    const prefix = bold ? BOLD : '';
    if (mode === 'truecolor') {
        return `${prefix}${ESC}38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
    }
    if (mode === '256') {
        return `${prefix}${ESC}38;5;${rgbTo256(rgb[0], rgb[1], rgb[2])}m`;
    }
    // 16-color fallback: lime -> 92 (bright green), steel/dim -> 90 (bright black/gray)
    const isLime = rgb === LIME_RGB || rgb === BRIGHT_LIME_RGB || rgb === GLOW_RGB;
    return `${prefix}${ESC}${isLime ? 92 : 90}m`;
}
/** Detect terminal color capability. */
function detectColorMode(opt) {
    if (typeof opt === 'string')
        return opt;
    if (opt === false)
        return 'none';
    if (process.env.NO_COLOR || process.env.CAUSYNE_NO_COLOR)
        return 'none';
    const force = process.env.FORCE_COLOR;
    if (force === '0')
        return 'none';
    if (force === '3')
        return 'truecolor';
    if (force === '2')
        return '256';
    if (force === '1')
        return '16';
    const colorterm = (process.env.COLORTERM || '').toLowerCase();
    if (colorterm === 'truecolor' || colorterm === '24bit')
        return 'truecolor';
    const term = (process.env.TERM || '').toLowerCase();
    if (term.includes('256color'))
        return '256';
    if (term === 'dumb')
        return 'none';
    return '256';
}
/** Detect terminal Unicode capability. */
function hasUnicode(opt) {
    if (typeof opt === 'boolean')
        return opt;
    if (process.env.CAUSYNE_ASCII === '1')
        return false;
    const lc = (process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || '').toLowerCase();
    if (lc.includes('utf-8') || lc.includes('utf8'))
        return true;
    return process.platform === 'darwin' || process.platform === 'win32';
}
export function detectSpinnerStyle() {
    const env = (process.env.CAUSYNE_SPINNER || '').trim().toLowerCase();
    if (env === 'iris' || env === 'aperture' || env === '6blade')
        return 'iris';
    if (env === 'reactor' || env === 'core' || env === 'chassis')
        return 'reactor';
    if (env === 'compact' || env === 'minimal' || env === 'mini')
        return 'compact';
    if (env === 'ascii' || env === 'plain')
        return 'ascii';
    return 'turbine';
}
// ---------------------------------------------------------------------------------------------------------
// Frame Generators
// ---------------------------------------------------------------------------------------------------------
/**
 * 4-Character Heavy Nacelle Turbine (Canonical Default):
 * ◖▄▀◗  ◖▙▜◗  ◖▌▐◗  ◖▛▟◗  ◖▀▄◗  ◖▜▙◗  ◖▐▌◗  ◖▟▛◗
 * Dual opposed blades rotate clockwise inside curved nacelle stator cowls.
 */
function buildTurbineFrames(mode) {
    const noColor = mode === 'none';
    const cLime = fgAnsi(BRIGHT_LIME_RGB, mode, true);
    const cDim = fgAnsi(DIM_RGB, mode);
    const cSteel = fgAnsi(STEEL_RGB, mode);
    const cGlow = fgAnsi(GLOW_RGB, mode);
    if (noColor) {
        return [
            '◖▄▀◗', '◖▙▜◗', '◖▌▐◗', '◖▛▟◗',
            '◖▀▄◗', '◖▜▙◗', '◖▐▌◗', '◖▟▛◗',
        ];
    }
    return [
        `${cSteel}◖${cDim}▄${cLime}▀${cSteel}◗${RESET}`,
        `${cSteel}◖${cDim}▙${cLime}▜${cGlow}◗${RESET}`,
        `${cDim}◖${cDim}▌${cLime}▐${cGlow}◗${RESET}`,
        `${cDim}◖${cDim}▛${cLime}▟${cGlow}◗${RESET}`,
        `${cSteel}◖${cLime}▀${cDim}▄${cSteel}◗${RESET}`,
        `${cGlow}◖${cLime}▜${cDim}▙${cDim}◗${RESET}`,
        `${cGlow}◖${cLime}▐${cDim}▌${cDim}◗${RESET}`,
        `${cGlow}◖${cLime}▟${cDim}▛${cSteel}◗${RESET}`,
    ];
}
/**
 * 3-Character 6-Blade Hex Iris Aperture:
 * Matches blade IDs 0 to 5 of the Causyne logo in banner.ts:
 * Blade 0 (top-right: ▜) -> Blade 1 (right: ▐) -> Blade 2 (bottom-right: ▟) ->
 * Blade 3 (bottom-left: ▙) -> Blade 4 (left: ▌) -> Blade 5 (top-left: ▛)
 */
function buildIrisFrames(mode) {
    const noColor = mode === 'none';
    const cLime = fgAnsi(BRIGHT_LIME_RGB, mode, true);
    const cSteel = fgAnsi(STEEL_RGB, mode);
    const cGlow = fgAnsi(GLOW_RGB, mode);
    if (noColor) {
        return ['◖▜◗', '◖▐◗', '◖▟◗', '◖▙◗', '◖▌◗', '◖▛◗'];
    }
    return [
        `${cSteel}◖${cLime}▜${cGlow}◗${RESET}`,
        `${cSteel}◖${cLime}▐${cGlow}◗${RESET}`,
        `${cSteel}◖${cLime}▟${cGlow}◗${RESET}`,
        `${cGlow}◖${cLime}▙${cSteel}◗${RESET}`,
        `${cGlow}◖${cLime}▌${cSteel}◗${RESET}`,
        `${cGlow}◖${cLime}▛${cSteel}◗${RESET}`,
    ];
}
/**
 * 4-Character Heavy Industrial Reactor Chassis:
 * ⟦▄▀⟧  ⟦▙▜⟧  ⟦▌▐⟧  ⟦▛▟⟧  ⟦▀▄⟧  ⟦▜▙⟧  ⟦▐▌⟧  ⟦▟▛⟧
 */
function buildReactorFrames(mode) {
    const noColor = mode === 'none';
    const cLime = fgAnsi(BRIGHT_LIME_RGB, mode, true);
    const cDim = fgAnsi(DIM_RGB, mode);
    const cSteel = fgAnsi(STEEL_RGB, mode);
    if (noColor) {
        return [
            '⟦▄▀⟧', '⟦▙▜⟧', '⟦▌▐⟧', '⟦▛▟⟧',
            '⟦▀▄⟧', '⟦▜▙⟧', '⟦▐▌⟧', '⟦▟▛⟧',
        ];
    }
    return [
        `${cSteel}⟦${cDim}▄${cLime}▀${cSteel}⟧${RESET}`,
        `${cSteel}⟦${cDim}▙${cLime}▜${cSteel}⟧${RESET}`,
        `${cSteel}⟦${cDim}▌${cLime}▐${cSteel}⟧${RESET}`,
        `${cSteel}⟦${cDim}▛${cLime}▟${cSteel}⟧${RESET}`,
        `${cSteel}⟦${cLime}▀${cDim}▄${cSteel}⟧${RESET}`,
        `${cSteel}⟦${cLime}▜${cDim}▙${cSteel}⟧${RESET}`,
        `${cSteel}⟦${cLime}▐${cDim}▌${cSteel}⟧${RESET}`,
        `${cSteel}⟦${cLime}▟${cDim}▛${cSteel}⟧${RESET}`,
    ];
}
/**
 * 2-Character Compact Dual Blade Rotor:
 * ▄▀  ▙▜  ▌▐  ▛▟  ▀▄  ▜▙  ▐▌  ▟▛
 */
function buildCompactFrames(mode) {
    const noColor = mode === 'none';
    const cLime = fgAnsi(BRIGHT_LIME_RGB, mode, true);
    const cDim = fgAnsi(DIM_RGB, mode);
    if (noColor) {
        return ['▄▀', '▙▜', '▌▐', '▛▟', '▀▄', '▜▙', '▐▌', '▟▛'];
    }
    return [
        `${cDim}▄${cLime}▀${RESET}`,
        `${cDim}▙${cLime}▜${RESET}`,
        `${cDim}▌${cLime}▐${RESET}`,
        `${cDim}▛${cLime}▟${RESET}`,
        `${cLime}▀${cDim}▄${RESET}`,
        `${cLime}▜${cDim}▙${RESET}`,
        `${cLime}▐${cDim}▌${RESET}`,
        `${cLime}▟${cDim}▛${RESET}`,
    ];
}
/**
 * 4-Character ASCII Fallback:
 * [--]  [\\]  [||]  [//]
 */
function buildAsciiFrames(mode) {
    const noColor = mode === 'none';
    const cLime = fgAnsi(BRIGHT_LIME_RGB, mode, true);
    const cSteel = fgAnsi(STEEL_RGB, mode);
    if (noColor) {
        return ['[--]', '[\\\\]', '[||]', '[//]'];
    }
    return [
        `${cSteel}[${cLime}--${cSteel}]${RESET}`,
        `${cSteel}[${cLime}\\\\${cSteel}]${RESET}`,
        `${cSteel}[${cLime}||${cSteel}]${RESET}`,
        `${cSteel}[${cLime}//${cSteel}]${RESET}`,
    ];
}
/**
 * Return the full set of frames for the given style and options.
 */
export function getEngineFrames(options = {}) {
    const unicode = hasUnicode(options.unicode);
    const colorMode = detectColorMode(options.color);
    const style = unicode ? (options.style || detectSpinnerStyle()) : 'ascii';
    switch (style) {
        case 'iris':
            return buildIrisFrames(colorMode);
        case 'reactor':
            return buildReactorFrames(colorMode);
        case 'compact':
            return buildCompactFrames(colorMode);
        case 'ascii':
            return buildAsciiFrames(colorMode);
        case 'turbine':
        default:
            return buildTurbineFrames(colorMode);
    }
}
/**
 * Return a single rendered frame for the current tick index.
 */
export function getEngineFrame(tick, options = {}) {
    const frames = getEngineFrames(options);
    const index = Math.abs(Math.floor(tick)) % frames.length;
    const frame = frames[index];
    return frame !== undefined ? frame : frames[0] || '◖▄▀◗';
}
