import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveTaskTokenCeiling, peerCallTokenCeiling, peerNativeActionCeiling,
  isTerminalBudgetFailure, hasBillablePartialUsage, shouldRetryPeerError,
  desktopDeadline, remainingDesktopTime, positiveSafeInteger,
  DEFAULT_AGY_TASK_TOKENS, DEFAULT_AGY_CALL_TOKENS
} from '../src/budget/budgetPolicy.js';

test('defaults are advisory only, including autonomy C and Antigravity', () => {
  assert.equal(DEFAULT_AGY_TASK_TOKENS, 80000);
  assert.equal(DEFAULT_AGY_CALL_TOKENS, 32000);
  for (const provider of ['antigravity', 'agy', 'openrouter']) {
    assert.equal(resolveTaskTokenCeiling({ provider }), null);
  }
  assert.equal(peerCallTokenCeiling(undefined), null);
  assert.equal(peerCallTokenCeiling(Infinity), null);
  assert.equal(peerCallTokenCeiling(null), null);
});
test('worker and explicitly enabled hard limits take precedence; soft settings stay soft', () => {
  assert.equal(resolveTaskTokenCeiling({ provider: 'antigravity', workerLimit: 6000 }), 6000);
  assert.equal(resolveTaskTokenCeiling({ provider: 'agy', configured: { enabled: true, hardStop: true, maxTokensPerTask: 250000 } }), 250000);
  assert.equal(resolveTaskTokenCeiling({ provider: 'agy', configured: { enabled: true, hardStop: false, maxTokensPerTask: 100 } }), null);
  assert.equal(resolveTaskTokenCeiling({ provider: 'agy', configured: { enabled: false, hardStop: true, maxTokensPerTask: 100 } }), null);
  assert.equal(resolveTaskTokenCeiling({ provider: 'agy', workerLimit: 6000, configured: { enabled: true, hardStop: true, maxTokensPerTask: 9000 } }), 6000);
  assert.equal(resolveTaskTokenCeiling({ provider: 'agy', workerLimit: 10000, configured: { enabled: true, hardStop: true, maxTokensPerTask: 9000 } }), 9000);
});
test('per-call limit uses actual authorized budget, not an arbitrary 32k slice', () => {
  assert.equal(peerCallTokenCeiling(500000), 500000);
  assert.equal(peerCallTokenCeiling(1200), 1200);
  assert.equal(peerCallTokenCeiling(0), 0);
  for (const value of [-2, Infinity, NaN, '1e12', {}, null]) assert.equal(peerCallTokenCeiling(value), null);
  for (const value of [-2, 0, Infinity, NaN, '5e100', '3.2', {}, null]) assert.equal(positiveSafeInteger(value), null);
});
test('native action and desktop wall ceilings require explicit authorization', () => {
  assert.equal(peerNativeActionCeiling(undefined, true), null);
  assert.equal(peerNativeActionCeiling(Infinity, false), null);
  assert.equal(peerNativeActionCeiling(13, true), 13);
  assert.equal(peerNativeActionCeiling(0, false), 0);
  assert.equal(desktopDeadline(1000, 'desktop_personalization'), null);
  assert.equal(desktopDeadline(1000, 'desktop_personalization', 900000), 901000);
  assert.equal(desktopDeadline(1000, 'software_engineering', 900000), null);
  assert.equal(remainingDesktopTime(901000, 900000), 1000);
});
test('explicit budget failures remain terminal, partial work is never retried', () => {
  for (const code of ['TASK_TOKEN_BUDGET', 'PROVIDER_TOKEN_BUDGET', 'AGY_DESKTOP_TASK_LIMIT', 'AGY_TOKEN_BUDGET', 'AGY_NATIVE_ACTION_BUDGET', 'AGY_TASK_DEADLINE', 'TASK_WALL_BUDGET']) {
    const error = Object.assign(new Error('stop'), { code });
    assert.equal(isTerminalBudgetFailure(error), true);
    assert.equal(shouldRetryPeerError(error), false);
  }
  const err = Object.assign(new Error('reset'), { partialUsage: { promptTokens: 100, completionTokens: 10 } });
  assert.equal(hasBillablePartialUsage(err), true);
  assert.equal(shouldRetryPeerError(err), false);
  assert.equal(shouldRetryPeerError(new Error('offline'), true), false);
});
