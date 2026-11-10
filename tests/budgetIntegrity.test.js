import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isTerminalBudgetFailure,
  resolveTaskTokenCeiling,
  peerCallTokenCeiling
} from '../src/budget/budgetPolicy.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('AgentLoop has no autonomous million-token extension after a budget failure', () => {
  const code = source('src/agentLoop.ts');
  assert.doesNotMatch(code, /extraTokens\s*=\s*Math\.max\(stepScale\s*\*\s*10,\s*1_000_000\)/);
  assert.match(code, /if \(isTerminalBudgetFailure\(e\)\)/);
  assert.match(code, /tokenTracker\.setEnforcedTaskLimit\(guardLimit\)/);
  assert.match(code, /tokenTracker\.resetTask\(\)/);
  assert.match(code, /taskDeadlineMs: this\._taskWallDeadlineAt/);
});

test('Antigravity cannot skip checkpoint when hardBudget is false', () => {
  const code = source('src/providers/antigravity.ts');
  assert.doesNotMatch(code, /isAutonomous\s*\?\s*Infinity/);
  assert.doesNotMatch(code, /!isAutonomous\s*&&\s*Number\.isFinite\(maxNativeActions\)/);
  assert.match(code, /shouldRetryPeerError\(err/);
  assert.match(code, /const tokenLimit = peerCallTokenCeiling\(requestedLimit\)/);
});

test('TokenTracker retains the per-task ceiling after reload', async () => {
  assert.ok(process.env.CAUSYNE_HOME, 'Tests must load tests/helpers/isolateState.js before importing TokenTracker');
  const { TokenTracker } = await import('../src/tokenTracker.js');
  const tracker = new TokenTracker();
  tracker.resetTask();
  tracker.setEnforcedTaskLimit(100);
  assert.equal(tracker.budget.maxTokensPerTask, 100);
  assert.equal(tracker.budget.enabled, true);
  assert.equal(tracker.budget.hardStop, true);
  const first = await tracker.trackUsage(40, 10);
  assert.equal(first.allowed, true);
  const next = await tracker.trackUsage(60, 10);
  assert.equal(next.allowed, false);
  assert.equal(next.taskTokens, 120);
  tracker.resetTask();
  assert.equal(tracker.taskTokens, 0);
  assert.equal(tracker.enforcedTaskTokenLimit, null);
});

test('A peer budget stop cannot be retried through the provider wrapper', async () => {
  const { AntigravityProvider } = await import('../src/providers/antigravity.js');
  const provider = new AntigravityProvider({ model: 'Gemini 3.8 Flash (Low)', command: 'no-executable-called' });
  let invocations = 0;
  provider._executeOnce = async () => {
    invocations++;
    throw Object.assign(new Error('180-second ceiling reached'), { code: 'AGY_DESKTOP_TASK_LIMIT' });
  };
  await assert.rejects(provider.chat([], { hardBudget: false, maxRetries: 3 }), { code: 'AGY_DESKTOP_TASK_LIMIT' });
  assert.equal(invocations, 1);
});

test('A transient error with already billed partial usage is not replayed', async () => {
  const { AntigravityProvider } = await import('../src/providers/antigravity.js');
  const provider = new AntigravityProvider({ model: 'Gemini 3.8 Flash (Low)', command: 'no-executable-called' });
  let invocations = 0;
  provider._executeOnce = async () => {
    invocations++;
    throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET', partialUsage: { promptTokens: 200, completionTokens: 25 } });
  };
  await assert.rejects(provider.chat([], { hardBudget: false, maxRetries: 2 }), { code: 'ECONNRESET' });
  assert.equal(invocations, 1);
});

test('Budget policy is finite under default and gives explicit limits precedence', () => {
  assert.equal(resolveTaskTokenCeiling({ provider: 'antigravity' }), 80_000);
  assert.equal(resolveTaskTokenCeiling({ provider: 'antigravity', configured: { enabled: true, maxTokensPerTask: 10_000 } }), 10_000);
  assert.equal(peerCallTokenCeiling(20_000), 20_000);
  assert.equal(isTerminalBudgetFailure({ code: 'AGY_NATIVE_ACTION_BUDGET' }), true);
});
