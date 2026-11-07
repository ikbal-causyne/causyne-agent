/**
 * Engine Spinner Adapter for CausyneRotor.
 *
 * Bridges the terminal spinner interfaces directly to CausyneRotor.ts.
 */
export { renderCausyneRotor, startCausyneRotor, getRotorSpinnerFrames, getRotorSpinnerFrame, getAnimatedDots, formatAnimatedStatus, COLORS, } from './CausyneRotor.js';
import { getRotorSpinnerFrames, getRotorSpinnerFrame, } from './CausyneRotor.js';
export function detectSpinnerStyle() {
    return 'turbine';
}
export function getEngineFrames(options = {}) {
    const unicode = options.unicode !== false;
    const color = options.color !== false && options.color !== 'none';
    return getRotorSpinnerFrames(color, unicode);
}
export function getEngineFrame(tick, options = {}) {
    const unicode = options.unicode !== false;
    const color = options.color !== false && options.color !== 'none';
    return getRotorSpinnerFrame(tick, color, unicode);
}
