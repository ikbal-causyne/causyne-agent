import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TimeMachine } from '../src/timeMachine.js';

test('different workspace spellings isolate retry budgets by actual directory', () => {
  const machine = new TimeMachine();
  const failure = { success: false, error: 'test failed', exitCode: 1 };
  const one = { command: 'npm test', cwd: '/workspace/one' };
  const two = { command: 'npm test', workingDirectory: '/workspace/two' };
  const twoCanonical = { command: 'npm test', cwd: '/workspace/two' };
  const three = { command: 'npm test', workingDir: '/workspace/three' };
  const threeRoot = { command: 'npm test', workspaceRoot: '/workspace/three' };

  assert.equal(machine.observe('exec', one, failure).attempt, 1);
  assert.equal(machine.observe('exec', two, failure).attempt, 1);
  assert.equal(machine.observe('exec', twoCanonical, failure).attempt, 2);
  assert.equal(machine.observe('exec', three, failure).attempt, 1);
  assert.equal(machine.observe('exec', threeRoot, failure).attempt, 2);
  assert.equal(machine.observe('exec', one, { success: true, exitCode: 0 }).kind, 'resolved');
  assert.equal(machine.observe('exec', two, failure).attempt, 3);
});
