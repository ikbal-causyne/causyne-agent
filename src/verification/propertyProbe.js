const LIMITS = Object.freeze({ trials: 500, steps: 500, actions: 1000, replay: 20000 });

function integer(name, value, maximum) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(name + ' must be an integer between 0 and ' + maximum);
  }
  return value;
}

function failure(value) {
  if (value && typeof value.then === 'function') throw new TypeError('Async invariants are not supported');
  return value === true ? null : (typeof value === 'string' ? value : 'Invariant returned false');
}

function nextRandom(state) {
  let value = state.value >>> 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  state.value = value >>> 0;
  return state.value;
}

function runPath(initial, transition, invariant, path) {
  let state;
  try {
    state = initial();
  } catch (error) {
    return { failed: true, reason: String(error?.message || error), step: -1 };
  }
  try {
    const error = failure(invariant(state));
    if (error) return { failed: true, reason: error, step: -1 };
  } catch (error) {
    return { failed: true, reason: String(error?.message || error), step: -1 };
  }
  for (let i = 0; i < path.length; i++) {
    try {
      const next = transition(state, path[i]);
      if (next && typeof next.then === 'function') throw new TypeError('Async transitions are not supported');
      if (next !== undefined) state = next;
      const error = failure(invariant(state));
      if (error) return { failed: true, reason: error, step: i };
    } catch (error) {
      return { failed: true, reason: String(error?.message || error), step: i };
    }
  }
  return { failed: false, reason: null, step: path.length };
}

function shrinkPath(path, fails, budget) {
  let current = path.slice();
  let chunk = Math.ceil(current.length / 2);
  while (chunk > 0 && budget.left > 0) {
    let changed = false;
    for (let offset = 0; offset < current.length && budget.left > 0; offset += chunk) {
      const candidate = current.slice(0, offset).concat(current.slice(offset + chunk));
      budget.left--;
      if (fails(candidate)) {
        current = candidate;
        changed = true;
        break;
      }
    }
    if (!changed) chunk = Math.floor(chunk / 2);
  }
  return current;
}

/**
 * Deterministic bounded property exploration for real transition handlers.
 * Pass a fresh initial() per replay; never report a bounded pass as a proof.
 */
export function verifyActionSequences(options = {}) {
  const { initial, transition, invariant, actions } = options;
  if (typeof initial !== 'function' || typeof transition !== 'function'
      || typeof invariant !== 'function') {
    throw new TypeError('initial, transition, and invariant must be functions');
  }
  if (!Array.isArray(actions) || actions.length === 0 || actions.length > LIMITS.actions) {
    throw new RangeError('actions must be a nonempty bounded array');
  }
  const seed = integer('seed', options.seed ?? 1, 0xffffffff);
  const trials = integer('trials', options.trials ?? 100, LIMITS.trials);
  const maxSteps = integer('maxSteps', options.maxSteps ?? 32, LIMITS.steps);
  if (trials === 0) throw new RangeError('trials must be positive');
  const random = { value: seed === 0 ? 0x6d2b79f5 : seed };
  let executed = 0;

  for (let trial = 0; trial < trials; trial++) {
    const path = [];
    for (let step = 0; step < maxSteps; step++) {
      path.push(actions[nextRandom(random) % actions.length]);
    }
    executed += path.length;
    const observed = runPath(initial, transition, invariant, path);
    if (!observed.failed) continue;
    const originalTrace = path.slice(0, Math.max(0, observed.step + 1));
    const budget = { left: LIMITS.replay };
    const trace = shrinkPath(originalTrace, candidate => {
      const result = runPath(initial, transition, invariant, candidate);
      return result.failed && result.reason === observed.reason;
    }, budget);
    const minimized = runPath(initial, transition, invariant, trace);
    return {
      status: 'counterexample', seed, trial, maxSteps, trialsRun: trial + 1,
      transitionsGenerated: executed, trace, originalTrace,
      reason: minimized.reason, shrinkReplays: LIMITS.replay - budget.left,
      evidence: 'replayable transition-handler counterexample, not a formal proof'
    };
  }
  return {
    status: 'bounded-pass', seed, trialsRun: trials, maxSteps,
    transitionsGenerated: executed,
    evidence: 'deterministic seeded action-sequence sampling only; not exhaustive or a formal proof'
  };
}
