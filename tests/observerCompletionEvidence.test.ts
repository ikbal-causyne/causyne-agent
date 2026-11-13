import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CausyneObserver } from '../src/observer.js';

test('read-only tool success cannot verify an unsubstantiated completion claim', () => {
  const observation = new CausyneObserver().evaluate({
    taskId: 'unverified-read-only',
    workspaceRoot: '/tmp',
    userGoal: 'Implement and test the requested feature',
    agentClaim: 'Done, implemented and verified.',
    toolHistory: [{
      tool: 'fs_read',
      args: { path: 'README.md' },
      success: true,
      path: 'README.md',
      at: Date.now()
    }]
  });
  assert.equal(observation.status, 'progressing');
  assert.equal(observation.verified, false);
  assert.match(observation.message ?? '', /without supporting verification evidence/i);
});

test('a passing test can still substantiate a read-only verification task', () => {
  const observation = new CausyneObserver().evaluate({
    taskId: 'check-only',
    workspaceRoot: '/tmp',
    userGoal: 'Verify the existing tests pass',
    agentClaim: 'Verified the existing tests',
    toolHistory: [{
      tool: 'sysRun',
      args: { command: 'npm test' },
      success: true,
      command: 'npm test',
      exitCode: 0,
      at: Date.now()
    }]
  });
  assert.equal(observation.status, 'verified');
  assert.equal(observation.verified, true);
});
