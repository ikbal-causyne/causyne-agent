/**
 * @file vfeTracker.js
 * Variational Free Energy (VFE) Tracker & Active Inference Plateau Detector.
 *
 * Implements Active Inference principles (Friston et al. / Research Section D):
 * In language-mediated active inference, VFE represents the prediction error
 * between the agent's expected environmental state transitions and actual
 * tool execution outcomes.
 *
 * Detection Rule (Research Section D5):
 * When Var(VFE_recent) < VARIANCE_EPSILON and Mean(VFE_recent) > MEAN_ERROR_THRESHOLD
 * over a sliding window (N=10), the agent has converged onto a flat error plateau
 * (a local minimum). Retrying local step variations will waste tokens. Instead,
 * the agent must execute a PARADIGM SHIFT: re-evaluate underlying assumptions,
 * invalidate the current operational hypothesis, and select a fundamentally
 * different route.
 *
 * Zero LLM calls. Computed purely from execution signals already tracked.
 */

import { failureClass } from './planCache.js';

/** Window size for rolling VFE metrics (default N=10 steps). */
export const VFE_WINDOW_SIZE = 10;

/** Minimum observations needed before plateau detection can trigger. */
export const MIN_SAMPLES_FOR_PLATEAU = 4;

/** Upper bound on variance to qualify as a "plateau" (stuck with no progress). */
export const VARIANCE_EPSILON = 0.01;

/** Lower bound on mean error to qualify as high-error plateau. */
export const MEAN_ERROR_THRESHOLD = 0.50;

/** Minimum step interval between paradigm shift triggers to prevent spamming. */
export const SHIFT_COOLDOWN_STEPS = 5;

/** Hard route-breaking failure categories from uncertainty taxonomy. */
const ROUTE_BREAKING_FAILURES = new Set(['not_found', 'permission', 'syntax', 'invalid_args']);

export class VFETracker {
  /**
   * @param {Object} [options]
   * @param {number} [options.windowSize=10]
   * @param {number} [options.varianceEpsilon=0.01]
   * @param {number} [options.meanThreshold=0.50]
   */
  constructor(options = {}) {
    this.windowSize = options.windowSize || VFE_WINDOW_SIZE;
    this.varianceEpsilon = options.varianceEpsilon || VARIANCE_EPSILON;
    this.meanThreshold = options.meanThreshold || MEAN_ERROR_THRESHOLD;

    /** @type {Array<{ step: number, vfe: number, tool: string, success: boolean }>} */
    this.history = [];
    this.lastShiftStep = -SHIFT_COOLDOWN_STEPS;
    this.totalSteps = 0;
  }

  /**
   * Reset tracker state for a fresh task.
   */
  reset() {
    this.history = [];
    this.lastShiftStep = -SHIFT_COOLDOWN_STEPS;
    this.totalSteps = 0;
  }

  /**
   * Compute the VFE (prediction error proxy) for a single tool execution step.
   *
   * @param {Object} stepData
   * @param {boolean} stepData.success
   * @param {Object} [stepData.result]
   * @param {number} [stepData.consecutiveFailures=0]
   * @param {boolean} [stepData.isThrashing=false]
   * @returns {number} VFE score in [0.0, 1.0]
   */
  computeStepVFE({ success, result, consecutiveFailures = 0, isThrashing = false }) {
    if (success) {
      // Nominal observation matches expected state: minimal free energy
      return 0.05;
    }

    // Base prediction error for an unexpected negative outcome
    let vfe = 0.65;

    // Consecutive repetitions of failure increase prediction mismatch
    if (consecutiveFailures > 1) {
      vfe += Math.min(0.20, (consecutiveFailures - 1) * 0.10);
    }

    // Hard route errors (missing file, invalid syntax) mean mental model is wrong
    if (result) {
      const fClass = failureClass(result);
      if (fClass && ROUTE_BREAKING_FAILURES.has(fClass)) {
        vfe += 0.15;
      }
    }

    // Thrashing tool calls mean cyclic un-converging belief state
    if (isThrashing) {
      vfe += 0.15;
    }

    return Math.min(1.0, Math.max(0.0, vfe));
  }

  /**
   * Record a completed tool step and compute rolling window statistics.
   *
   * @param {Object} params
   * @param {string} params.tool
   * @param {boolean} params.success
   * @param {Object} [params.result]
   * @param {number} [params.consecutiveFailures=0]
   * @param {boolean} [params.isThrashing=false]
   * @returns {{
   *   vfe: number,
   *   mean: number,
   *   variance: number,
   *   isPlateau: boolean,
   *   paradigmShift: boolean
   * }}
   */
  recordStep({ tool, success, result, consecutiveFailures = 0, isThrashing = false }) {
    this.totalSteps += 1;
    const currentStep = this.totalSteps;

    const vfe = this.computeStepVFE({ success, result, consecutiveFailures, isThrashing });

    this.history.push({ step: currentStep, vfe, tool, success });
    if (this.history.length > this.windowSize) {
      this.history.shift();
    }

    const stats = this.computeWindowStats();
    const isPlateau = (
      this.history.length >= MIN_SAMPLES_FOR_PLATEAU &&
      stats.mean >= this.meanThreshold &&
      stats.variance <= this.varianceEpsilon
    );

    const canShift = (currentStep - this.lastShiftStep) >= SHIFT_COOLDOWN_STEPS;
    const paradigmShift = isPlateau && canShift;

    if (paradigmShift) {
      this.lastShiftStep = currentStep;
    }

    return {
      vfe,
      mean: stats.mean,
      variance: stats.variance,
      isPlateau,
      paradigmShift
    };
  }

  /**
   * Calculate mean and sample variance over the current sliding window.
   * @returns {{ mean: number, variance: number, count: number }}
   */
  computeWindowStats() {
    const n = this.history.length;
    if (n === 0) return { mean: 0, variance: 0, count: 0 };
    if (n === 1) return { mean: this.history[0].vfe, variance: 0, count: 1 };

    const sum = this.history.reduce((acc, item) => acc + item.vfe, 0);
    const mean = sum / n;

    const sumSqDiff = this.history.reduce((acc, item) => {
      const diff = item.vfe - mean;
      return acc + (diff * diff);
    }, 0);

    const variance = sumSqDiff / (n - 1);

    return {
      mean: Number(mean.toFixed(4)),
      variance: Number(variance.toFixed(6)),
      count: n
    };
  }

  /**
   * Get the current status for telemetry or debugging.
   */
  getStatus() {
    const stats = this.computeWindowStats();
    const isPlateau = (
      this.history.length >= MIN_SAMPLES_FOR_PLATEAU &&
      stats.mean >= this.meanThreshold &&
      stats.variance <= this.varianceEpsilon
    );
    return {
      totalSteps: this.totalSteps,
      windowCount: this.history.length,
      mean: stats.mean,
      variance: stats.variance,
      isPlateau
    };
  }

  /**
   * Format the high-priority paradigm shift prompt directive.
   *
   * @returns {string}
   */
  getParadigmShiftDirective() {
    return (
      `\n\n🚨 [PARADIGM SHIFT REQUIRED — ACTIVE INFERENCE DEADLOCK DETECTED]\n` +
      `Variational Free Energy tracking detected a persistent error plateau with zero convergence.\n` +
      `Your current mental model and execution route are trapped in a local minimum.\n` +
      `DO NOT retry previous variations, tweak parameters, or repeat failed commands.\n` +
      `1. Explicitly identify which core assumption failed.\n` +
      `2. State your revised hypothesis about the environment/codebase.\n` +
      `3. Choose a fundamentally different tool, strategy, or alternative path.\n`
    );
  }
}
