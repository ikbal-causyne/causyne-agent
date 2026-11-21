const DEFAULT_MAX_STATES = 256;
const DEFAULT_MAX_DEPTH = 7;
function isThenable(value) {
    return Boolean(value && (typeof value === 'object' || typeof value === 'function') && typeof value.then === 'function');
}
function finiteBound(value, fallback, maximum, label) {
    const bound = value === undefined ? fallback : value;
    if (typeof bound !== 'number' || !Number.isSafeInteger(bound) || bound < 0 || bound > maximum) {
        throw new RangeError('Invalid ' + label);
    }
    return bound;
}
function clone(value) {
    try {
        return structuredClone(value);
    }
    catch {
        throw new TypeError('State and actions must be structured-cloneable');
    }
}
function textLabel(value, limit = 80) {
    const cleaned = String(value ?? '')
        // eslint-disable-next-line no-control-regex
        .replace(/[\x00-\x1f\x7f<>"\x60\\|[\]{};#]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return (cleaned || 'unnamed').slice(0, limit);
}
function callSync(fn, value, label) {
    const result = fn(clone(value));
    if (isThenable(result)) {
        throw new TypeError('Async ' + label + ' is not supported');
    }
    return result;
}
function assertion(invariant, state) {
    const value = callSync(invariant, state, 'invariant');
    return value === true ? null : textLabel(typeof value === 'string' ? value : 'Invariant returned false', 200);
}
function isEquivalent(left, right) {
    if (Object.is(left, right))
        return true;
    try {
        return JSON.stringify(left) === JSON.stringify(right);
    }
    catch {
        return false;
    }
}
export function buildBoundedStatechart(options = {}) {
    const safeOptions = options && typeof options === 'object' ? options : {};
    const { initial, actions, transition, invariant } = safeOptions;
    const stateKey = safeOptions.stateKey || JSON.stringify;
    const stateLabel = safeOptions.stateLabel || ((value) => JSON.stringify(value));
    const actionLabel = safeOptions.actionLabel || ((value) => String(value));
    const maxDepth = finiteBound(safeOptions.maxDepth, DEFAULT_MAX_DEPTH, 16, 'maxDepth');
    const maxStates = finiteBound(safeOptions.maxStates, DEFAULT_MAX_STATES, 2000, 'maxStates');
    if (!Array.isArray(actions) || actions.length < 1 || actions.length > 64) {
        throw new RangeError('Action alphabet must contain 1..64 entries');
    }
    if (!maxStates)
        throw new RangeError('maxStates must be positive');
    for (const fn of [transition, invariant, stateKey, stateLabel, actionLabel]) {
        if (typeof fn !== 'function')
            throw new TypeError('Model callbacks must be functions');
    }
    const alphabet = actions.map(clone);
    const root = clone(initial);
    const nodes = [];
    const edges = [];
    const byKey = new Map();
    const failures = [];
    let incomplete = false;
    let exploredDepth = 0;
    function getKey(value) {
        const key = callSync(stateKey, value, 'stateKey');
        if (typeof key !== 'string')
            throw new TypeError('stateKey must return a string');
        return key;
    }
    function addNode(state, trace) {
        const id = 'S' + nodes.length;
        const label = callSync(stateLabel, state, 'stateLabel');
        const reason = assertion(invariant, state);
        const node = {
            id,
            state: clone(state),
            trace,
            depth: trace.length,
            label: textLabel(label),
            reason
        };
        nodes.push(node);
        byKey.set(getKey(state), node);
        if (reason && failures.length < 32) {
            failures.push({ state: id, trace: trace.map(item => item.label), reason });
        }
        return node;
    }
    addNode(root, []);
    for (let head = 0; head < nodes.length && !incomplete; head++) {
        const node = nodes[head];
        exploredDepth = Math.max(exploredDepth, node.depth);
        if (node.depth >= maxDepth)
            continue;
        for (const action of alphabet) {
            const label = textLabel(callSync(actionLabel, action, 'actionLabel'), 50);
            const next = transition(clone(node.state), clone(action));
            if (isThenable(next)) {
                throw new TypeError('Async transitions are not supported');
            }
            if (next === undefined || next === null)
                continue;
            const stable = clone(next);
            const nextKey = getKey(stable);
            let target = byKey.get(nextKey);
            if (target && !isEquivalent(target.state, stable)) {
                throw new Error('stateKey collision: distinct states share a key');
            }
            if (!target && nodes.length >= maxStates) {
                incomplete = true;
                break;
            }
            if (!target) {
                target = addNode(stable, node.trace.concat({ label }));
            }
            edges.push({ from: node.id, to: target.id, action: label });
        }
    }
    const lines = ['stateDiagram-v2', '    [*] --> S0'];
    for (const node of nodes) {
        lines.push('    state "' + node.label + '" as ' + node.id);
    }
    for (const edge of edges) {
        lines.push('    ' + edge.from + ' --> ' + edge.to + ': ' + edge.action);
    }
    for (const fail of failures) {
        lines.push('    note right of ' + fail.state + ': ' + fail.reason);
    }
    return {
        status: failures.length ? 'counterexample' : incomplete ? 'incomplete' : 'bounded-pass',
        completeWithinBounds: !incomplete, maxDepth, maxStates,
        stateCount: nodes.length, transitionCount: edges.length,
        exploredDepth, counterexamples: failures, diagram: lines.join('\n') + '\n',
        evidence: 'Bounded exploration of the supplied JavaScript transition function, not a TLA+ TLC run or an unbounded proof'
    };
}
