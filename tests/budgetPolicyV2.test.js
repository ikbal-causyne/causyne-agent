import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveTaskTokenCeiling, peerCallTokenCeiling, peerNativeActionCeiling,
  desktopDeadline, shouldRetryPeerError
} from '../src/budget/budgetPolicy.js';

test('no invented hard budget in autonomy C', () => {
  assert.equal(resolveTaskTokenCeiling({provider:'antigravity', configured:{enabled:false,hardStop:false,maxTokensPerTask:1}}),null);
  assert.equal(peerCallTokenCeiling(Number.POSITIVE_INFINITY), null);
  assert.equal(peerNativeActionCeiling(undefined,true),null);
  assert.equal(desktopDeadline(Date.now(),'desktop_personalization'),null);
});
test('user hard caps remain exact, including 0 remaining and 1M explicit ceiling', () => {
  assert.equal(resolveTaskTokenCeiling({provider:'antigravity',configured:{enabled:true,hardStop:true,maxTokensPerTask:1000000}}),1000000);
  assert.equal(peerCallTokenCeiling(1000000),1000000);
  assert.equal(peerCallTokenCeiling(0),0);
  assert.equal(peerNativeActionCeiling(12,true),12);
});
test('partial billable usage still blocks automatic retry', () => {
  assert.equal(shouldRetryPeerError({code:'ECONNRESET',partialUsage:{promptTokens:32001,completionTokens:10}}),false);
});
