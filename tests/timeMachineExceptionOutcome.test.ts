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
