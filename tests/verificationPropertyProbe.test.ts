import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyActionSequences } from '../src/verification/propertyProbe.js';
import { ChatPrompt } from '../src/tui/prompt.js';
import { handlePromptEscape } from '../src/tui/composerControls.js';

test('seeded verification is deterministic and explains its bounded scope', () => {
  const opts = {
    initial: () => ({ open: false }),
    actions: ['open', 'work', 'close'],
    transition: (state, action) => {
      if (action === 'open') state.open = true;
      if (action === 'close') state.open = false;
    },
    invariant: state => typeof state.open === 'boolean',
    seed: 17, trials: 40, maxSteps: 12
  };
  const a = verifyActionSequences(opts);
  const b = verifyActionSequences(opts);
  assert.deepEqual(a, b);
  assert.equal(a.status, 'bounded-pass');
  assert.equal(a.transitionsGenerated, 480);
  assert.match(a.evidence, /not exhaustive or a formal proof/);
});

test('counterexample shrinks a stateful regression to its required actions', () => {
  const result = verifyActionSequences({
    initial: () => ({ open: false, illegallyHidden: false }),
    actions: ['open', 'work', 'close', 'no-op'],
    transition: (state, action) => {
      if (action === 'open') { state.open = true; state.illegallyHidden = false; }
      if (action === 'close') state.open = false;
      if (action === 'work' && state.open) state.illegallyHidden = true;
    },
    invariant: state => !state.illegallyHidden || 'work closed an open panel',
    seed: 42, trials: 100, maxSteps: 20
  });
  assert.equal(result.status, 'counterexample');
  assert.deepEqual(result.trace, ['open', 'work']);
  assert.equal(result.reason, 'work closed an open panel');
  assert.ok(result.originalTrace.length >= result.trace.length);
});

test('exception witnesses retain the faulting action and preserve error identity', () => {
  const result = verifyActionSequences({
    initial: () => ({ started: false }),
    actions: ['begin', 'explode'],
    transition: (state, action) => {
      if (action === 'begin') state.started = true;
      if (action === 'explode' && state.started) throw new Error('fault reached');
    },
    invariant: () => true,
    seed: 123, trials: 20, maxSteps: 12
  });
  assert.equal(result.status, 'counterexample');
  assert.deepEqual(result.trace, ['begin', 'explode']);
  assert.equal(result.reason, 'fault reached');
});

test('invalid bounds and unsupported stateful entrypoints fail closed', () => {
  const baseline = { initial: () => 0, transition: () => 0, invariant: () => true,
    actions: ['step'] };
  assert.throws(() => verifyActionSequences({ ...baseline, trials: 0 }), /trials must be positive/);
  assert.throws(() => verifyActionSequences({ ...baseline, seed: -1 }), /seed/);
  assert.throws(() => verifyActionSequences({ ...baseline, maxSteps: 501 }), /maxSteps/);
  assert.throws(() => verifyActionSequences({ ...baseline, actions: [] }), /actions/);
});

test('property runner drives actual Causyne status and Escape handlers', () => {
  const result = verifyActionSequences({
    initial: () => {
      const prompt = new ChatPrompt({ root: process.cwd(), isCommand: text => text.startsWith('/') });
      prompt.erase = () => {};
      prompt.scheduleDraw = () => {};
      prompt.draw = () => {};
      prompt.startTick = () => {};
      prompt.stopTick = () => {};
      prompt.renderSubmittedUserMessage = () => {};
      prompt.history = { add() {} };
      prompt.onInterrupt = () => {};
      prompt.onExit = () => {};
      prompt.waiter = () => {};
      return { prompt, pinned: false };
    },
    actions: ['open', 'submit', 'begin', 'finish', 'escape'],
    transition: (state, action) => {
      const prompt = state.prompt;
      if (action === 'open') {
        state.pinned = prompt.toggleStatusCard();
      } else if (action === 'submit') {
        prompt.editor.setText('verify the behavior');
        prompt.submit();
      } else if (action === 'begin') {
        prompt.setBusy(true);
      } else if (action === 'finish') {
        prompt.setBusy(false);
      } else if (action === 'escape') {
        handlePromptEscape(prompt, () => ['interrupted']);
        state.pinned = false;
      }
    },
    invariant: state => Boolean(state.prompt.statusCard) === state.pinned
      || 'active status panel changed without explicit user close',
    seed: 20261117, trials: 18, maxSteps: 14
  });
  assert.equal(result.status, 'bounded-pass', JSON.stringify(result));
});

test('async transition results are never accepted as synchronous proof', () => {
  const report = verifyActionSequences({
    initial: () => ({ done: false }),
    actions: ['write'], trials: 1, maxSteps: 1,
    transition: async state => ({ ...state, done: true }),
    invariant: () => true
  });
  assert.equal(report.status, 'counterexample');
  assert.deepEqual(report.trace, ['write']);
  assert.match(report.reason, /Async transitions are not supported/);
});

test('async invariant results cannot silently count as successful verification', () => {
  const report = verifyActionSequences({
    initial: () => 0, actions: ['tick'], trials: 1, maxSteps: 1,
    transition: state => state + 1,
    invariant: async () => true
  });
  assert.equal(report.status, 'counterexample');
  assert.deepEqual(report.trace, []);
  assert.match(report.reason, /Async invariants are not supported/);
});
