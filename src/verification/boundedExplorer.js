const DEFAULT_DEPTH = 6;
const DEFAULT_STATES = 10_000;

function boundedInteger(value, fallback, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new RangeError('Invalid exploration bound');
  }
  return value;
}

export function exploreStateMachine(options) {
  const { initial, actions, transition, invariant } = options || {};
  if (!Array.isArray(actions) || actions.length === 0) throw new TypeError('actions must be nonempty');
  if (actions.length > 10000) throw new RangeError('Too many actions to explore safely');
  if (typeof transition !== 'function') throw new TypeError('transition must be a function');
  if (typeof invariant !== 'function') throw new TypeError('invariant must be a function');

  if (initial && typeof initial.then === 'function') {
    throw new TypeError('Async initial state is not supported by synchronous model exploration');
  }
  const maxDepth = boundedInteger(options.maxDepth, DEFAULT_DEPTH, 32);
  const maxStates = boundedInteger(options.maxStates, DEFAULT_STATES, 100_000);
  if (maxStates === 0) throw new RangeError('maxStates must be positive');
  const key = options.stateKey || JSON.stringify;
  if (typeof key !== 'function') throw new TypeError('stateKey must be a function');

  const checkedState = value => {
    try { return structuredClone(value); }
    catch { throw new TypeError('State must be structured-cloneable for sound bounded exploration'); }
  };
  const checkedAction = value => {
    try { return structuredClone(value); }
    catch { throw new TypeError('Actions must be structured-cloneable for sound bounded exploration'); }
  };
  const stableActions = actions.map(checkedAction);
  const startState = checkedState(initial);
  const startKey = key(checkedState(startState));
  if (startKey && typeof startKey.then === 'function') {
    throw new TypeError('Async stateKey is not supported');
  }
  if (typeof startKey !== 'string') throw new TypeError('stateKey must produce a string');
  let nodesVisited = 1;
  let transitions = 0;
  let deepest = 0;
  const root = { state: startState, trace: [] };
  const queue = [root];
  const seen = new Set([startKey]);

  function failed(node) {
    const result = invariant(checkedState(node.state));
    if (result && typeof result.then === 'function') {
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
    const current = queue[head];
    deepest = Math.max(deepest, current.trace.length);
    if (current.trace.length >= maxDepth) continue;
    for (const action of stableActions) {
      // Each branch must start from the same immutable snapshot. A mutating
      // transition otherwise poisons later siblings and can produce false proofs.
      const isolated = checkedState(current.state);
      const next = transition(isolated, checkedAction(action));
      if (next && typeof next.then === 'function') {
        throw new TypeError('Async transitions are not supported');
      }
      transitions++;
      if (next === null || next === undefined) continue;
      const trace = current.trace.concat(action);
      const nextNode = { state: next, trace };
      const failure = failed(nextNode);
      if (failure) return failure;
      const identity = key(checkedState(next));
      if (identity && typeof identity.then === 'function') {
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
