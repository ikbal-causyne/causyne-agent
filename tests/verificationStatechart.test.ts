import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBoundedStatechart } from '../src/verification/statechart.js';

const base = {
  initial: { panel: 'none', queued: 0 },
  actions: ['open', 'submit', 'close'],
  transition: (state, action) => {
    if (action === 'open') return { ...state, panel: 'usage' };
    if (action === 'submit' && state.queued < 2) return { ...state, queued: state.queued + 1 };
    if (action === 'close') return { ...state, panel: 'none' };
    return null;
  },
  invariant: s => s.panel === 'none' || s.panel === 'usage'
};

test('statechart explores a bounded model and emits observed transition labels', () => {
  const result = buildBoundedStatechart({ ...base, maxDepth: 3 });
  assert.equal(result.status, 'bounded-pass', JSON.stringify(result));
  assert.match(result.diagram, /^stateDiagram-v2/);
  assert.match(result.diagram, /S0 --> S1: open/);
  assert.match(result.diagram, /S0 --> S\d+: submit/);
  assert.ok(result.transitionCount > 0);
  assert.ok(result.stateCount >= 3);
  assert.equal(result.completeWithinBounds, true);
  assert.match(result.evidence, /not a TLA\+ TLC run/);
});

test('broken transition produces a shortest counterexample and visible violation', () => {
  const result = buildBoundedStatechart({
    initial: { approved: false, wrote: false },
    actions: ['approve', 'write'],
    transition: (state, action) => action === 'write'
      ? { ...state, wrote: true }
      : { ...state, approved: true },
    invariant: s => !s.wrote || s.approved || 'write without approval'
  });
  assert.equal(result.status, 'counterexample');
  assert.deepEqual(result.counterexamples[0].trace, ['write']);
  assert.match(result.diagram, /note right of S\d+: write without approval/);
});

test('incomplete graph is not reported as verification success', () => {
  const result = buildBoundedStatechart({
    initial: 0, actions: ['increment'],
    transition: s => s + 1, invariant: () => true,
    maxStates: 2, maxDepth: 8
  });
  assert.equal(result.status, 'incomplete');
  assert.equal(result.completeWithinBounds, false);
  assert.equal(result.stateCount, 2);
});

test('transition action objects and invariant state snapshots are isolated', () => {
  const input = [{ delta: 1 }];
  const result = buildBoundedStatechart({
    initial: { count: 0, started: false }, actions: input,
    transition: (state, action) => {
      state.count += action.delta;
      action.delta = 100;
      return { count: state.count, started: true };
    },
    invariant: state => {
      if (!state.started) {
        state.count = 42;
        return true;
      }
      return state.count < 4 || 'state mutation escaped';
    },
    maxDepth: 3
  });
  assert.equal(result.status, 'bounded-pass', JSON.stringify(result));
  assert.deepEqual(input, [{ delta: 1 }]);
  assert.equal(result.stateCount, 4);
});

test('colliding state identities cause a hard error rather than an unsound pass', () => {
  assert.throws(() => buildBoundedStatechart({
    initial: { n: 0 }, actions: ['tick'],
    transition: s => ({ n: s.n + 1 }), invariant: () => true,
    stateKey: () => 'same', maxDepth: 2
  }), /collision/);
});

test('labels cannot inject Mermaid chart syntax from model data', () => {
  const result = buildBoundedStatechart({
    initial: { value: 'quoted' }, actions: ['open"\nstate MALICIOUS'],
    transition: () => ({ value: 'next' }), invariant: () => true,
    stateLabel: state => 'X"\n[*] --> HACKED <script>' + state.value,
    maxDepth: 1
  });
  assert.doesNotMatch(result.diagram, /\n\[\*\] --> HACKED/);
  assert.doesNotMatch(result.diagram, /<script>/);
  assert.doesNotMatch(result.diagram, /^\s*state MALICIOUS/m);
});

test('async or uncloneable model inputs cannot be reported as verified', () => {
  assert.throws(() => buildBoundedStatechart({
    ...base, transition: async state => state
  }), /Async transitions/);
  assert.throws(() => buildBoundedStatechart({
    ...base, actions: [{ callback: () => 5 }]
  }), /structured-cloneable/);
  assert.throws(() => buildBoundedStatechart({
    ...base, maxStates: 0
  }), /maxStates/);
});
