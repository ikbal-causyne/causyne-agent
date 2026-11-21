const DEFAULT_DEPTH = 6;
const DEFAULT_STATES = 10_000;

export interface ExploreStateMachineOptions<TState = any, TAction = any> {
  initial: TState;
  actions: readonly TAction[];
  transition: (state: TState, action: TAction) => TState | null | undefined;
  invariant: (state: TState) => boolean | string;
  maxDepth?: number;
  maxStates?: number;
  stateKey?: (state: TState) => string;
}

export interface ExploreStateMachineResult<TState = any, TAction = any> {
  status: 'bounded-pass' | 'counterexample' | 'incomplete';
  depthLimit: number;
  statesExplored: number;
  transitionsExplored: number;
  exploredDepth: number;
  trace: TAction[];
  state?: TState;
  reason: string;
}

function boundedInteger(value: unknown, fallback: number, maximum: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new RangeError('Invalid exploration bound');
  }
  return value;
}

function isThenable(value: unknown): boolean {
  return Boolean(value && (typeof value === 'object' || typeof value === 'function') && typeof (value as { then?: unknown }).then === 'function');
}

export function exploreStateMachine<TState = any, TAction = any>(
  options: ExploreStateMachineOptions<TState, TAction>
): ExploreStateMachineResult<TState, TAction> {
  if (!options || typeof options !== 'object') throw new TypeError('options object is required');
  const safeOptions = options as Partial<ExploreStateMachineOptions<TState, TAction>>;
  const { initial, actions, transition, invariant } = safeOptions;
  if (!Array.isArray(actions) || actions.length === 0) throw new TypeError('actions must be nonempty');
  if (actions.length > 10000) throw new RangeError('Too many actions to explore safely');
  if (typeof transition !== 'function') throw new TypeError('transition must be a function');
  if (typeof invariant !== 'function') throw new TypeError('invariant must be a function');

  if (isThenable(initial)) {
    throw new TypeError('Async initial state is not supported by synchronous model exploration');
  }
  const maxDepth = boundedInteger(safeOptions.maxDepth, DEFAULT_DEPTH, 32);
  const maxStates = boundedInteger(safeOptions.maxStates, DEFAULT_STATES, 100_000);
  if (maxStates === 0) throw new RangeError('maxStates must be positive');
  const key = safeOptions.stateKey || ((value: TState): string => {
    try {
      const serialized = JSON.stringify(value);
      if (typeof serialized !== 'string') throw new TypeError('stateKey must produce a string');
      return serialized;
    } catch {
      throw new TypeError('State must be JSON-serializable or provide a custom stateKey');
    }
  });
  if (typeof key !== 'function') throw new TypeError('stateKey must be a function');

  const checkedState = <T>(value: T): T => {
    try { return structuredClone(value); }
    catch { throw new TypeError('State must be structured-cloneable for sound bounded exploration'); }
  };
  const checkedAction = <T>(value: T): T => {
    try { return structuredClone(value); }
    catch { throw new TypeError('Actions must be structured-cloneable for sound bounded exploration'); }
  };
  const stableActions = actions.map(checkedAction);
  const startState = checkedState(initial as TState);
  const startKey = key(checkedState(startState));
  if (isThenable(startKey)) {
    throw new TypeError('Async stateKey is not supported');
  }
  if (typeof startKey !== 'string') throw new TypeError('stateKey must produce a string');
  let nodesVisited = 1;
  let transitions = 0;
  let deepest = 0;
  const root: { state: TState; trace: TAction[] } = { state: startState, trace: [] };
  const queue: Array<{ state: TState; trace: TAction[] }> = [root];
  const seen = new Set<string>([startKey]);

  function failed(node: { state: TState; trace: TAction[] }): ExploreStateMachineResult<TState, TAction> | null {
    const result = invariant!(checkedState(node.state));
    if (isThenable(result)) {
      throw new TypeError('Async invariants are not supported');
    }
    if (result === true) return null;
    return {
      status: 'counterexample',
      depthLimit: maxDepth,
      statesExplored: nodesVisited,
      transitionsExplored: transitions,
      exploredDepth: node.trace.length,
      trace: node.trace,
      state: node.state,
      reason: typeof result === 'string' ? result : 'Invariant returned false'
    };
  }

  const initialFailure = failed(root);
  if (initialFailure) return initialFailure;
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head]!;
    deepest = Math.max(deepest, current.trace.length);
    if (current.trace.length >= maxDepth) continue;
    for (const action of stableActions) {
      const isolated = checkedState(current.state);
      const next = transition(isolated, checkedAction(action));
      if (isThenable(next)) {
        throw new TypeError('Async transitions are not supported');
      }
      transitions++;
      if (next === null || next === undefined) continue;
      const trace = current.trace.concat(action);
      const nextNode = { state: next, trace };
      const failure = failed(nextNode);
      if (failure) return failure;
      const identity = key(checkedState(next));
      if (isThenable(identity)) {
        throw new TypeError('Async stateKey is not supported');
      }
      if (typeof identity !== 'string') throw new TypeError('stateKey must produce a string');
      if (seen.has(identity)) continue;
      if (nodesVisited >= maxStates) {
        return {
          status: 'incomplete',
          depthLimit: maxDepth,
          statesExplored: nodesVisited,
          transitionsExplored: transitions,
          exploredDepth: trace.length,
          trace: [],
          reason: 'Exploration reached maxStates before completing the bound'
        };
      }
      seen.add(identity);
      nodesVisited++;
      queue.push(nextNode);
    }
  }
  return {
    status: 'bounded-pass',
    depthLimit: maxDepth,
    statesExplored: nodesVisited,
    transitionsExplored: transitions,
    exploredDepth: deepest,
    trace: [],
    reason: 'Invariant holds for reachable states within the stated bound; not an unbounded proof'
  };
}
