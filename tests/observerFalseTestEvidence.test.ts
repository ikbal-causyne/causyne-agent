import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CausyneObserver } from '../src/observer.js';

test('mentioning test in a successful shell command is not a passing test', () => {
  const observer = new CausyneObserver();
  const result = observer.evaluate({
    taskId: 'echo-is-not-test', workspaceRoot: '/tmp',
    userGoal: 'Fix parser', agentClaim: 'Finished and verified',
    toolHistory: [
      { tool: 'fs_write', args: {}, success: true, error: '', exitCode: null, command: '', path: 'parser.ts', at: 1 },
      { tool: 'sysRun', args: {}, success: true, error: '', exitCode: 0, command: 'echo test passed', path: '', at: 2 }
    ]
  });
  assert.equal(result.verified, false);
  assert.equal(result.status, 'ready-to-verify');
});

test('a genuine successful test command is still accepted', () => {
  const observer = new CausyneObserver();
  const result = observer.evaluate({
    taskId: 'real-test', workspaceRoot: '/tmp', userGoal: 'Fix parser',
    agentClaim: 'Finished', toolHistory: [
      { tool: 'fs_write', args: {}, success: true, error: '', exitCode: null, command: '', path: 'parser.ts', at: 1 },
      { tool: 'sysRun', args: {}, success: true, error: '', exitCode: 0, command: 'npm test', path: '', at: 2 }
    ]
  });
  assert.equal(result.verified, true);
});
