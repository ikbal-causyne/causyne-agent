import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TimeMachine } from '../src/timeMachine.js';

test('distinct Git commands do not share retries or resolve one another', () => {
  const machine = new TimeMachine();
  const failure = { success: false, error: 'exit code 1', exitCode: 1 };
  const push = { command: 'git push origin main', cwd: '/workspace' };
  const status = { command: 'git status --short', cwd: '/workspace' };
  const commit = { command: 'git commit -m test', cwd: '/workspace' };

  assert.equal(machine.observe('exec', push, failure).attempt, 1);
  assert.equal(machine.observe('exec', status, failure).attempt, 1);
  assert.equal(machine.observe('exec', commit, failure).attempt, 1);
  assert.equal(machine.observe('exec', status, { success: true, exitCode: 0 }).kind, 'resolved');
  assert.equal(machine.observe('exec', push, failure).attempt, 2);
  assert.equal(machine.observe('exec', push, { success: true, exitCode: 0 }).kind, 'resolved');
  assert.equal(machine.observe('exec', commit, failure).attempt, 2);
});

test('common repo command shims normalize subcommand identities', () => {
  const machine = new TimeMachine();
  const failure = { success: false, error: 'command failed' };
  assert.equal(machine.observe('exec', { command: 'git.exe push' }, failure).attempt, 1);
  assert.equal(machine.observe('exec', { command: 'git push' }, failure).attempt, 2);
  assert.equal(machine.observe('exec', { command: 'gh run list' }, failure).attempt, 1);
  assert.equal(machine.observe('exec', { command: 'gh issue list' }, failure).attempt, 1);
});
