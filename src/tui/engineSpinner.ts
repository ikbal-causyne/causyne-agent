/**
 * Engine Spinner Adapter for CausyneRotor.
 *
 * Bridges the terminal spinner interfaces directly to CausyneRotor.ts.
 */

export {
  renderCausyneRotor,
  startCausyneRotor,
  getRotorSpinnerFrames,
  getRotorSpinnerFrame,
  getAnimatedDots,
  formatAnimatedStatus,
  COLORS,
  type RotorMotion,
  type RotorOptions,
} from './CausyneRotor.js';

import {
  getRotorSpinnerFrames,
  getRotorSpinnerFrame,
} from './CausyneRotor.js';

export type EngineSpinnerStyle = 'turbine' | 'iris' | 'reactor' | 'compact' | 'ascii';

export interface EngineSpinnerOptions {
  style?: EngineSpinnerStyle | undefined;
  unicode?: boolean | undefined;
  color?: boolean | 'truecolor' | '256' | '16' | 'none' | undefined;
}

export function detectSpinnerStyle(): EngineSpinnerStyle {
  return 'turbine';
}

export function getEngineFrames(options: EngineSpinnerOptions = {}): readonly string[] {
  const unicode = options.unicode !== false;
  const color = options.color !== false && options.color !== 'none';
  return getRotorSpinnerFrames(color, unicode);
}

export function getEngineFrame(tick: number, options: EngineSpinnerOptions = {}): string {
  const unicode = options.unicode !== false;
  const color = options.color !== false && options.color !== 'none';
  return getRotorSpinnerFrame(tick, color, unicode);
}
