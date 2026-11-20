import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TimeMachine } from '../src/timeMachine.js';

test('an Error object is not treated as a successful tool response', () => {
  const machine = new TimeMachine();
  const args = { command: 'npm run build' };
  const first = machine.observe('exec', args, new Error('temporary network failure'));
  assert.equal(first.kind, 'continue');
  assert.equal(first.attempt, 1);
  assert.equal(first.failureClass, 'network');

  const next = machine.observe('exec', args, new Error('temporary network failure'));
  assert.equal(next.attempt, 2);
  assert.notEqual(next.kind, 'resolved');
  assert.equal(machine.observe('exec', args, { success: true, exitCode: 0 }).kind, 'resolved');
});

test('an Error object carrying an approval or auth message routes to human intervention', () => {
  const machine = new TimeMachine();
  const decision = machine.observe('exec', { command: 'gh auth status' }, new Error('Authentication required'));
  assert.equal(decision.kind, 'human');
});
