import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TimeMachine } from '../src/timeMachine.js';

test('snake_case exit_code from tool adapters participates in retry accounting', () => {
  const machine = new TimeMachine();
  const args = { command: 'npm test' };
  const failed = machine.observe('exec', args, { exit_code: 1 });
  assert.equal(failed.kind, 'continue');
  assert.equal(failed.attempt, 1);
  assert.equal(machine.observe('exec', args, { exit_code: -1 }).attempt, 2);
  assert.equal(machine.observe('exec', args, { exit_code: 0 }).kind, 'resolved');
});

test('explicit canonical exitCode takes precedence over the alias', () => {
  const machine = new TimeMachine();
  const args = { command: 'npm test' };
  assert.equal(machine.observe('exec', args, { exitCode: 0, exit_code: 1 }).kind, 'none');
});
