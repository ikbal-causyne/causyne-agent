import test from 'node:test';
import assert from 'node:assert/strict';
import { exploreStateMachine } from '../src/verification/boundedExplorer.js';
import { assessVerification } from '../src/verificationPlan.js';

const idle = { running: false, approved: false, changed: false };
const actions = ['start', 'approve', 'write', 'stop'];
const transition = (state, action) => {
  if (action === 'start') return { ...state, running: true };
  if (action === 'approve') return { ...state, approved: true };
  if (action === 'write' && state.running && state.approved) return { ...state, changed: true };
  if (action === 'stop') return { ...state, running: false };
  return null;
};

test('bounded model checker exhaustively checks reachable states with bounded metadata', () => {
  const result = exploreStateMachine({
    initial: idle, actions, transition,
    invariant: state => !state.changed || state.approved,
    maxDepth: 7
  });
  assert.equal(result.status, 'bounded-pass');
  assert.ok(result.statesExplored >= 3);
  assert.ok(result.transitionsExplored > result.statesExplored);
  assert.equal(result.depthLimit, 7);
  assert.match(result.reason, /not an unbounded proof/);
});

test('deliberately broken authorization transition yields shortest counterexample', () => {
  const result = exploreStateMachine({
    initial: idle, actions,
    transition: (state, action) => action === 'write'
      ? { ...state, changed: true } : transition(state, action),
    invariant: state => !state.changed || state.approved,
    maxDepth: 5
  });
  assert.equal(result.status, 'counterexample');
  assert.deepEqual(result.trace, ['write']);
  assert.equal(result.exploredDepth, 1);
});

test('refuses success if the state budget ends before completing exploration', () => {
  const result = exploreStateMachine({
    initial: { n: 0 },
    actions: ['inc'],
    transition: state => ({ n: state.n + 1 }),
    invariant: () => true, maxDepth: 10, maxStates: 3
  });
  assert.equal(result.status, 'incomplete');
  assert.match(result.reason, /maxStates/);
});

test('validates options and checks the initial invariant', () => {
  assert.throws(() => exploreStateMachine({ actions: [], transition, invariant: () => true }), /nonempty/);
  assert.throws(() => exploreStateMachine({ initial: idle, actions, transition, invariant: () => true, maxDepth: -1 }), /bound/);
  const result = exploreStateMachine({ initial: idle, actions, transition, invariant: () => 'bad initial', maxDepth: 0 });
  assert.equal(result.status, 'counterexample');
  assert.deepEqual(result.trace, []);
  assert.equal(result.reason, 'bad initial');
});

test('model exploration directly exercises production verification assessment', () => {
  const codeChange = { tool: 'fs_write', path: 'test.js', success: true,
    args: { path: 'test.js' }, command: '', error: '', exitCode: 0, at: 1 };
  const compile = { tool: 'sysRun', path: '', success: true,
    args: { command: 'npm test' }, command: 'npm test', error: '', exitCode: 0, at: 2 };
  const fail = { ...compile, success: false, exitCode: 1 };
  const result = exploreStateMachine({
    initial: { outcomes: [] }, actions: [codeChange, compile, fail],
    transition: (state, action) => ({ outcomes: [...state.outcomes, action] }),
    stateKey: state => JSON.stringify(state.outcomes.map(o => [o.tool, o.success])),
    maxDepth: 4,
    invariant: state => {
      const list = state.outcomes;
      const lastCodeChange = list.findLastIndex(o => o.tool === 'fs_write' && o.success);
      if (lastCodeChange < 0) return true;
      const laterTest = list.slice(lastCodeChange + 1).some(o => o.command === 'npm test' && o.success);
      const gaps = assessVerification({ outcomes: list }).gaps;
      return laterTest || gaps.some(g => g.domain === 'code') || 'Missing verification was accepted';
    }
  });
  assert.equal(result.status, 'bounded-pass');
});

test('wide exploration retains deterministic shortest witness', () => {
  const choices = Array.from({ length: 150 }, (_, i) => i);
  const result = exploreStateMachine({
    initial: { step: 0, picked: -1 }, actions: choices,
    transition: (state, choice) => state.step === 0 ? { step: 1, picked: choice } : null,
    invariant: state => state.picked !== 149 || 'last choice violates property',
    maxDepth: 3, maxStates: 200
  });
  assert.equal(result.status, 'counterexample');
  assert.deepEqual(result.trace, [149]);
  assert.equal(result.exploredDepth, 1);
});

test('explorer rejects action alphabets too large to exhaust', () => {
  assert.throws(() => exploreStateMachine({
    initial: 0, actions: Array.from({ length: 10_001 }, (_, i) => i),
    transition: state => state, invariant: () => true
  }), /Too many actions/);
});


test('mutating transitions cannot contaminate sibling branches or create false counterexamples', () => {
  const result = exploreStateMachine({
    initial: { n: 0 }, actions: ['increment', 'observe'], maxDepth: 1,
    transition(state, action) {
      if (action === 'increment') {
        state.n++;
        return state;
      }
      return { ...state, observed: state.n };
    },
    invariant: state => state.observed === undefined || state.observed === 0
  });
  assert.equal(result.status, 'bounded-pass', JSON.stringify(result));
  assert.equal(result.statesExplored, 3);
});

test('bounded explorer fails explicitly rather than accepting uncloneable mutable states', () => {
  assert.throws(() => exploreStateMachine({
    initial: { callback: () => 7 }, actions: ['advance'], maxDepth: 1,
    transition: state => state, invariant: () => true
  }), /structured-cloneable/);
});

test('bounded model exploration rejects async entrypoints instead of returning a false pass', () => {
  const base = {
    initial: { count: 0 },
    actions: ['tick'],
    transition: state => ({ count: state.count + 1 }),
    invariant: () => true,
    maxDepth: 1
  };
  assert.throws(() => exploreStateMachine({
    ...base, initial: Promise.resolve({ count: 0 }), maxDepth: 0
  }), /Async initial/);
  assert.throws(() => exploreStateMachine({
    ...base, transition: async state => state
  }), /Async transitions/);
  assert.throws(() => exploreStateMachine({
    ...base, invariant: async () => true, maxDepth: 0
  }), /Async invariants/);
  assert.throws(() => exploreStateMachine({
    ...base, stateKey: async () => 'state', maxDepth: 0
  }), /Async stateKey/);
  assert.throws(() => exploreStateMachine({
    ...base, stateKey: state => state.count === 0 ? 'root' : Promise.resolve('next')
  }), /Async stateKey/);
});

test('invariant side effects cannot alter states explored by later actions', () => {
  const source = { count: 0, inspected: false };
  const result = exploreStateMachine({
    initial: source, actions: ['inspect'], maxDepth: 1,
    transition: state => ({ ...state, inspected: true }),
    invariant: state => {
      if (!state.inspected) state.count = 100;
      return state.count === 0 || 'invariant mutated the state used by transition';
    }
  });
  assert.equal(result.status, 'bounded-pass');
  assert.deepEqual(source, { count: 0, inspected: false });
});

test('mutation of action arguments never leaks to other branches or depths', () => {
  const actions = [{ kind: 'tick', amount: 1 }];
  const result = exploreStateMachine({
    initial: { count: 0 }, actions, maxDepth: 3,
    transition: (state, action) => {
      const amount = action.amount;
      action.amount = 999;
      return { count: state.count + amount };
    },
    invariant: state => state.count <= 3 || 'action object corrupted across transitions'
  });
  assert.equal(result.status, 'bounded-pass', JSON.stringify(result));
  assert.equal(actions[0].amount, 1);
  assert.equal(result.statesExplored, 4);
});

test('exploration fails closed on non-cloneable actions even when initial state is safe', () => {
  assert.throws(() => exploreStateMachine({
    initial: { count: 0 }, actions: [{ callback: () => true }],
    transition: state => state, invariant: () => true
  }), /Actions must be structured-cloneable/);
});

test('an invariant may not mutate the underlying reachable state', () => {
  const result = exploreStateMachine({
    initial: { count: 0 }, actions: ['step'], maxDepth: 2,
    transition: state => ({ count: state.count + 1 }),
    invariant: state => {
      state.count = -1;
      return true;
    }
  });
  assert.equal(result.status, 'bounded-pass');
  assert.equal(result.statesExplored, 3);
});
