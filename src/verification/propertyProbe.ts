const LIMITS = Object.freeze({ trials: 500, steps: 500, actions: 1000, replay: 20000 });

export interface VerifyActionSequencesOptions<TState = any, TAction = any> {
  initial?: () => TState;
  transition?: (state: TState, action: TAction) => TState | void;
  invariant?: (state: TState) => boolean | string;
  actions?: readonly TAction[];
  seed?: number;
  trials?: number;
  maxSteps?: number;
}

export interface VerifyActionSequencesResult<TAction = any> {
  status: 'bounded-pass' | 'counterexample';
  seed: number;
  trial?: number;
  trialsRun: number;
  maxSteps: number;
  transitionsGenerated: number;
  trace?: TAction[];
  originalTrace?: TAction[];
  reason?: string | null;
  shrinkReplays?: number;
  evidence: string;
}

function isThenable(value: unknown): boolean {
  return Boolean(value && (typeof value === 'object' || typeof value === 'function') && typeof (value as { then?: unknown }).then === 'function');
}

function integer(name: string, value: unknown, maximum: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new RangeError(name + ' must be an integer between 0 and ' + maximum);
  }
  return value;
}

function failure(value: unknown): string | null {
  if (isThenable(value)) throw new TypeError('Async invariants are not supported');
  return value === true ? null : (typeof value === 'string' ? value : 'Invariant returned false');
}

function nextRandom(state: { value: number }): number {
  let value = state.value >>> 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  state.value = value >>> 0;
  return state.value;
}

function runPath<TState, TAction>(
  initial: () => TState,
  transition: (state: TState, action: TAction) => TState | void,
  invariant: (state: TState) => boolean | string,
  path: readonly TAction[]
): { failed: boolean; reason: string | null; step: number } {
  let state: TState;
  try {
    state = initial();
    if (isThenable(state)) {
      throw new TypeError('Async initial state is not supported');
    }
  } catch (error: unknown) {
    return { failed: true, reason: String(error instanceof Error ? error.message : error).slice(0, 1024), step: -1 };
  }
  try {
    const error = failure(invariant(state));
    if (error) return { failed: true, reason: error.slice(0, 1024), step: -1 };
  } catch (error: unknown) {
    return { failed: true, reason: String(error instanceof Error ? error.message : error).slice(0, 1024), step: -1 };
  }
  for (let i = 0; i < path.length; i++) {
    try {
      const action = structuredClone(path[i]!);
      const next = transition(state, action);
      if (isThenable(next)) throw new TypeError('Async transitions are not supported');
      if (next !== undefined) state = next;
      const error = failure(invariant(state));
      if (error) return { failed: true, reason: error.slice(0, 1024), step: i };
    } catch (error: unknown) {
      return { failed: true, reason: String(error instanceof Error ? error.message : error).slice(0, 1024), step: i };
    }
  }
  return { failed: false, reason: null, step: path.length };
}

function shrinkPath<TAction>(
  path: readonly TAction[],
  fails: (candidate: TAction[]) => boolean,
  budget: { left: number }
): TAction[] {
  if (!Array.isArray(path) || path.length === 0 || !budget || budget.left <= 0) return [];
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

export function verifyActionSequences<TState = any, TAction = any>(
  options: VerifyActionSequencesOptions<TState, TAction> = {}
): VerifyActionSequencesResult<TAction> {
  if (!options || typeof options !== 'object') throw new TypeError('options object is required');
  const safeOptions = options;
  const { initial, transition, invariant, actions } = safeOptions;
  if (typeof initial !== 'function' || typeof transition !== 'function'
      || typeof invariant !== 'function') {
    throw new TypeError('initial, transition, and invariant must be functions');
  }
  if (!Array.isArray(actions) || actions.length === 0 || actions.length > LIMITS.actions) {
    throw new RangeError('actions must be a nonempty bounded array');
  }
  const seed = integer('seed', safeOptions.seed ?? 1, 0xffffffff);
  const trials = integer('trials', safeOptions.trials ?? 100, LIMITS.trials);
  const maxSteps = integer('maxSteps', safeOptions.maxSteps ?? 32, LIMITS.steps);
  if (trials === 0) throw new RangeError('trials must be positive');
  const random = { value: seed === 0 ? 0x6d2b79f5 : seed };
  let executed = 0;

  for (let trial = 0; trial < trials; trial++) {
    const path: TAction[] = [];
    for (let step = 0; step < maxSteps; step++) {
      path.push(actions[nextRandom(random) % actions.length]!);
    }
    executed += path.length;
    const observed = runPath(initial, transition, invariant, path);
    if (!observed.failed) continue;
    const originalTrace = path.slice(0, Math.max(0, observed.step + 1));
    const budget = { left: LIMITS.replay };
    const trace = shrinkPath(originalTrace, candidate => {
      const result = runPath(initial!, transition!, invariant!, candidate);
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
