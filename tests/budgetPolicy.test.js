import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveTaskTokenCeiling, peerCallTokenCeiling, peerNativeActionCeiling,
  isTerminalBudgetFailure, hasBillablePartialUsage, shouldRetryPeerError,
  desktopDeadline, remainingDesktopTime, positiveSafeInteger,
  DEFAULT_AGY_TASK_TOKENS, DEFAULT_AGY_CALL_TOKENS
} from '../src/budget/budgetPolicy.js';

test('Antigravity gets a finite per-task budget without user config', () => {
  assert.equal(resolveTaskTokenCeiling({ provider: 'antigravity' }), DEFAULT_AGY_TASK_TOKENS);
  assert.equal(resolveTaskTokenCeiling({ provider: 'agy' }), DEFAULT_AGY_TASK_TOKENS);
  assert.equal(resolveTaskTokenCeiling({ provider: 'openrouter' }), null);
});
test('explicit user and worker ceilings are respected without silent enlargement', () => {
  assert.equal(resolveTaskTokenCeiling({ provider: 'antigravity', configured: { enabled: true, maxTokensPerTask: 8500 }}), 8500);
  assert.equal(resolveTaskTokenCeiling({ provider: 'antigravity', configured: { enabled: true, maxTokensPerTask: 200000 }}), 200000);
  assert.equal(resolveTaskTokenCeiling({ provider: 'antigravity', workerLimit: 6000, configured: { enabled: true, maxTokensPerTask: 200000 }}), 6000);
  assert.equal(resolveTaskTokenCeiling({ provider: 'antigravity', configured: { enabled: false, maxTokensPerTask: 1_000_000 }}), DEFAULT_AGY_TASK_TOKENS);
});
test('malformed numeric values cannot bypass limits', () => {
  for (const input of [-2, 0, Infinity, NaN, '5e100', '3.2', {}, null]) assert.equal(positiveSafeInteger(input), null);
  assert.equal(peerCallTokenCeiling(Infinity), DEFAULT_AGY_CALL_TOKENS);
  assert.equal(peerCallTokenCeiling(1200), 1200);
  assert.equal(peerCallTokenCeiling(0), 0);
});
test('native action counts cannot be unlimited through autonomy', () => {
  assert.equal(peerNativeActionCeiling(Infinity, false), 128);
  assert.equal(peerNativeActionCeiling(Infinity, true), 12);
  assert.equal(peerNativeActionCeiling(3, false), 3);
  assert.equal(peerNativeActionCeiling(0, false), 0);
  assert.equal(peerNativeActionCeiling(500, true), 12);
});
test('all provider budget stops are terminal regardless of autonomy mode', () => {
  for (const code of ['TASK_TOKEN_BUDGET','PROVIDER_TOKEN_BUDGET','AGY_DESKTOP_TASK_LIMIT','AGY_TOKEN_BUDGET','AGY_NATIVE_ACTION_BUDGET','AGY_TASK_DEADLINE','TASK_WALL_BUDGET']) {
    const error = Object.assign(new Error('stop'), { code });
    assert.equal(isTerminalBudgetFailure(error), true);
    assert.equal(shouldRetryPeerError(error), false);
  }
});
test('a partially billed turn is not silently replayed after a transient failure', () => {
  const err = Object.assign(new Error('connection reset'), { code: 'ECONNRESET', partialUsage: { promptTokens: 125, completionTokens: 20 } });
  assert.equal(hasBillablePartialUsage(err), true);
  assert.equal(shouldRetryPeerError(err), false);
  assert.equal(shouldRetryPeerError(new Error('unreachable'), true), false);
  assert.equal(shouldRetryPeerError(new Error('unreachable')), true);
});
test('desktop task has one absolute deadline across multiple model calls', () => {
  const deadline = desktopDeadline(1000, 'desktop_personalization');
  assert.equal(deadline, 181000);
  assert.equal(remainingDesktopTime(deadline, 140000), 41000);
  assert.equal(remainingDesktopTime(deadline, 181001), 0);
  assert.equal(desktopDeadline(1000, 'software_engineering'), null);
});
