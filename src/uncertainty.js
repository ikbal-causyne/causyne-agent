import { failureClass } from './planCache.js';

// Step-level uncertainty, computed from signals the loop already holds.
//
// WHAT THIS IS NOT, AND WHY.
//
// The research spec asked for CATTS-style gating: sample N candidate actions,
// measure entropy and the top-1/top-2 margin across them, and escalate when the
// samples disagree. Two findings killed that design.
//
//   1. The CATTS and OPPO papers are NOT in the research corpus. Asked
//      directly, it reported their absence three times. The spec cited them
//      second-hand, so their thresholds were never available to us.
//   2. More decisively: without token logprobs, every method in that family
//      measures disagreement by SAMPLING N completions. Causyne is BYOK across
//      ten providers and several expose no logprobs at all. Sampling N times to
//      decide whether to spend more is self-defeating — the gate would cost
//      more than the thing it gates.
//
// Asked which substitutes exist when logprobs are unavailable, the corpus named
// four: majority voting over N samples, an auxiliary verifier model, cross-tool
// execution matching, and verbalized self-critique. The first two each cost an
// extra model call. **The last two do not**, and they are what this module is
// built from, together with execution signals the loop already tracks for free.
//
// WHAT THE CORPUS THEN CONFIRMED (research round 3, questions A1-A7).
//
// "Dynamic Adaptive Reasoning: Intent-Aware Scheduling" (IARS) detects its
// reasoning states — Exploring, Confirming, Stuck/Ambiguous, Near-Answer — with
// one of two pipelines: a small trained classifier, OR **a text-based heuristic
// of keyword matching plus structural repetition analysis**, run as a parallel
// stream analyser with negligible cost and no logprobs. That second pipeline is
// this module. The thrash detector below is its "structural repetition"; the
// hedge patterns are its "keyword matching". So this is an implementation of a
// published detector, not an extrapolation.
//
// IARS issues four directives — [DEEPER_THINK], [STREAMLINE_THINK],
// [CONCLUDE_NOW], [RETRY_SUBPROBLEM] — and couples them to decoding:
// DEEPER_THINK raises temperature to widen the search; CONCLUDE_NOW drops into
// fast decoding. The paper states the DIRECTION of those changes and NOT the
// magnitudes ("present, but not stated"). The delta below is therefore ours.
//
// Two things the corpus ruled OUT, so nobody re-proposes them:
//   * REVERSE ("Generate, but Verify") gates on P(</UN>) > tau with tau = 0.003
//     (LLaVA) / 0.01 (Qwen2.5-VL). It needs a model FINE-TUNED to emit that
//     token — unavailable over BYOK — and its measured overhead is 3.05x tokens.
//     A gate that triples the bill is the failure this module exists to avoid.
//   * Verbalized self-confidence (a model rating its own confidence) is NOT
//     evaluated or calibrated anywhere in the corpus. The hedge patterns here
//     are used as IARS-style Stuck/Ambiguous keyword detection, never as a
//     calibrated confidence score, and they cannot cross the gate alone.
//
// HONEST LIMITS:
//   * No single signal can move the score past the escalation threshold alone.
//   * The WEIGHTS are engineering judgement, not published constants. The
//     corpus validates the SIGNALS (IARS, OBLIVION's query-to-buffer cosine
//     similarity) but publishes no weights for combining them. They are named
//     constants so measured values can replace them without touching logic.

/**
 * @typedef {Object} StepSignals
 * @property {number}  [consecutiveFailures]  Failures in a row, from the loop.
 * @property {any}     [lastResult]           The previous tool result, if any.
 * @property {string}  [lastTool]             Name of the previous tool.
 * @property {string}  [pendingTool]          The tool about to be called.
 * @property {string[]}[recentTools]          Recent tool names, oldest first.
 * @property {number}  [planSimilarity]       0..1 plan-cache match, if any.
 * @property {number}  [lessonSimilarity]     0..1 Cortex retrieval match, if any.
 * @property {string}  [assistantText]        The model's own last message.
 * @property {number}  [logprobMargin]        top1-top2 in nats, when a provider exposes it.
 * @property {boolean} [vfePlateau]           Whether variational free energy has plateaued.
 */

/**
 * @typedef {Object} Assessment
 * @property {number}   uncertainty  0 (settled) .. 1 (lost).
 * @property {'confident'|'contested'|'stuck'} level
 * @property {string[]} signals      Which contributors fired, for the audit trail.
 * @property {string}   directive    Prompt text to inject, or '' to stay silent.
 * @property {number}   temperatureDelta  Added to the task temperature for this
 *                      step. IARS couples its escalation directive to a wider
 *                      search; the direction is the paper's, the magnitude is
 *                      ours (see STUCK_TEMPERATURE_DELTA).
 */

/** Above this, the step is contested enough to be worth a reflection directive. */
export const CONTESTED_AT = 0.45;

/** Above this, the agent is not converging and should re-plan rather than retry. */
export const STUCK_AT = 0.75;

/**
 * How much wider the search gets when the agent is stuck.
 *
 * IARS: [DEEPER_THINK] / [RETRY_SUBPROBLEM] raise decoding temperature to
 * escape a local minimum. The paper gives the direction and no number
 * ("present, but not stated"), so this value is unmeasured. Kept small: a
 * stuck agent needs a different route, not a random one.
 */
export const STUCK_TEMPERATURE_DELTA = 0.2;

/**
 * No single signal may cross CONTESTED_AT alone.
 *
 * This is the rule that keeps a badly-calibrated signal from driving the gate.
 * Verbalized confidence in particular is unreliable enough that acting on it by
 * itself would fire reflection on ordinary hedging language.
 */
const MAX_SINGLE_CONTRIBUTION = 0.4;

const WEIGHTS = {
  consecutiveFailure: 0.25,  // per failure, capped below
  // Weighted ABOVE a bare failure count on purpose. Three failures say
  // "something is wrong"; a `not_found` class says WHAT — and a diagnosis is
  // worth more than a symptom. With this at 0.15, three failures on a wrong
  // route scored 0.60 and never reached the retry directive that exists for
  // exactly that case.
  hardFailureClass: 0.30,    // a failure that says the ROUTE is wrong
  thrash: 0.30,              // the same tool three times running
  vfePlateau: 0.35,          // Active Inference: error plateau with zero variance (stuck in local minimum)
  noPriorArt: 0.05,          // nothing in plan cache or Cortex to lean on
  hedging: 0.20,             // the model's own language says it is unsure
  logprobMargin: 0.25        // only when a provider actually exposes it
};

/**
 * Phrases in which a model reports its own uncertainty.
 *
 * Deliberately narrow. A broad list turns ordinary careful writing into a
 * signal, and a gate that fires on caution is a gate that fires always.
 * @type {RegExp}
 */
const HEDGE = /\b(i am not sure|i'm not sure|not certain|unclear (?:why|what|how)|might be|may be wrong|hard to tell|cannot determine|let me guess|assuming that|if that is the case|unsure)\b/i;

/**
 * Failure classes that mean the ROUTE is wrong rather than the moment.
 *
 * `network` and `rate_limited` are absent on purpose: retrying is the correct
 * response to those, and treating them as uncertainty would trigger a re-plan
 * for a problem that fixes itself.
 * @type {ReadonlySet<string>}
 */
const ROUTE_IS_WRONG = new Set(['not_found', 'permission', 'invalid_args', 'syntax']);

/**
 * Is the agent calling the same tool over and over?
 *
 * Repetition is the cheapest honest uncertainty signal there is: a converging
 * agent moves on. Three of the same in a row is the threshold because two is a
 * legitimate read-then-write pair.
 *
 * @param   {string[]} recent
 * @param   {string}   pending
 * @returns {boolean}
 */
export function isThrashing(recent, pending) {
  const tail = [...(recent || [])];
  if (pending) tail.push(pending);
  if (tail.length < 3) return false;
  const last3 = tail.slice(-3);
  return last3.every((t) => t && t === last3[0]);
}

/**
 * Score a step before committing to it.
 *
 * Every input is something the loop already has. Nothing here calls a model,
 * samples a completion, or touches the network — which is the entire point.
 *
 * @param   {StepSignals} signals
 * @returns {Assessment}
 */
export function assessStep(signals = {}) {
  const fired = [];
  let score = 0;

  /** Add a contributor, capped so no single one can decide the outcome. */
  const add = (amount, name) => {
    const capped = Math.min(amount, MAX_SINGLE_CONTRIBUTION);
    if (capped <= 0) return;
    score += capped;
    fired.push(name);
  };

  const failures = Number(signals.consecutiveFailures) || 0;
  if (failures > 0) add(Math.min(failures, 3) * WEIGHTS.consecutiveFailure, `failures:${failures}`);

  if (signals.lastResult) {
    const why = failureClass(signals.lastResult);
    if (why && ROUTE_IS_WRONG.has(why)) add(WEIGHTS.hardFailureClass, `route_wrong:${why}`);
  }

  if (isThrashing(signals.recentTools, signals.pendingTool)) {
    add(WEIGHTS.thrash, `thrash:${signals.pendingTool || 'repeat'}`);
  }

  if (signals.vfePlateau) {
    add(WEIGHTS.vfePlateau, 'vfe_plateau');
  }

  const bestPrior = Math.max(Number(signals.planSimilarity) || 0, Number(signals.lessonSimilarity) || 0);
  if (bestPrior === 0) add(WEIGHTS.noPriorArt, 'no_prior_art');

  if (typeof signals.assistantText === 'string' && HEDGE.test(signals.assistantText)) {
    add(WEIGHTS.hedging, 'model_hedged');
  }

  // Only when the provider genuinely reports it. A missing margin is NOT
  // evidence of confidence, so its absence contributes nothing in either
  // direction.
  if (typeof signals.logprobMargin === 'number' && Number.isFinite(signals.logprobMargin)) {
    if (signals.logprobMargin < 0.5) add(WEIGHTS.logprobMargin, 'logprob_margin_narrow');
  }

  const uncertainty = Math.min(1, score);
  const level = uncertainty >= STUCK_AT ? 'stuck' : uncertainty >= CONTESTED_AT ? 'contested' : 'confident';

  return {
    uncertainty,
    level,
    signals: fired,
    directive: directiveFor(level, fired),
    temperatureDelta: level === 'stuck' ? STUCK_TEMPERATURE_DELTA : 0
  };
}

/**
 * What to say to the model, if anything.
 *
 * Returns '' for a confident step. That empty string is the whole economic
 * argument: reflecting on every step is what the gating literature exists to
 * prevent, and the directive costs tokens on every step it appears in.
 *
 * @param   {string}   level
 * @param   {string[]} fired
 * @returns {string}
 */
export function directiveFor(level, fired = []) {
  if (level === 'confident') return '';

  const because = fired.length ? ` (${fired.join(', ')})` : '';

  if (level === 'stuck') {
    // Paradigm shift: when VFE plateau occurs, standard re-planning isn't enough;
    // the agent is stuck in an active-inference local minimum.
    if (fired.includes('vfe_plateau')) {
      return `[PARADIGM SHIFT REQUIRED — persistent error plateau with zero convergence${because}. `
        + 'Do NOT retry previous step variations or tweak command arguments. '
        + 'Invalidate your operational hypothesis, state in one line what fundamental assumption was wrong, '
        + 'and switch to a completely different tool, perspective, or strategy.]';
    }

    // IARS separates [RETRY_SUBPROBLEM] from a full re-plan. A wrong ROUTE
    // with no thrashing means this one sub-problem needs a different approach;
    // thrashing means the plan itself is not converging.
    const thrashing = fired.some((f) => f.startsWith('thrash:'));
    if (!thrashing) {
      return `[RETRY_SUBPROBLEM — the last approach to THIS step failed in a way that says the route was wrong${because}. `
        + 'Keep the overall plan. Solve this one step by a different route. '
        + 'If a tool reported "not found", that is evidence about the ROUTE, not proof the thing is absent.]';
    }
    return `[RE-PLAN — the last few steps are not converging${because}. `
      + 'Do NOT retry the same route. State in one line what you now believe is actually true, '
      + 'name the assumption that turned out to be wrong, and choose a different approach. '
      + 'If a tool reported "not found", that is evidence about the ROUTE, not proof the thing is absent.]';
  }

  return `[CHECK YOURSELF — this step looks contested${because}. `
    + 'Before calling the tool, say in one line what you expect it to return. '
    + 'If the result contradicts that expectation, treat the expectation as the thing that was wrong.]';
}
