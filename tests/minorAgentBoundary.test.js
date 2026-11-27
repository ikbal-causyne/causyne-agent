import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitForAbortableDelay } from '../src/agent/abortableDelay.js';
import { classifyAgentError, getRetryHintForError } from '../src/agent/errorClassifier.js';

test('retry timer rejects values outside the native timeout range', async () => {
  for (const delay of [NaN, Infinity, -1, 2_147_483_648]) {
    await assert.rejects(waitForAbortableDelay(delay), RangeError);
  }
  const controller = new AbortController();
  const pending = waitForAbortableDelay(2_147_483_647, controller.signal);
  controller.abort();
  assert.equal(await pending, 'aborted');
  assert.equal(await waitForAbortableDelay(0), 'elapsed');
});

test('error classification tolerates malformed usage without losing valid usage', () => {
  for (const value of [Symbol('bad'), Object.create(null), true]) {
    assert.equal(classifyAgentError({ status: 429, partialUsage: { promptTokens: value } }), 'rate_limit');
  }
  assert.equal(classifyAgentError({ status: 429, partialUsage: { promptTokens: '12' } }), 'fatal');
});

test('unknown retry hints never return inherited object members', () => {
  for (const key of ['__proto__', 'constructor', 'toString']) {
    assert.equal(getRetryHintForError(key), getRetryHintForError('unknown_error'));
  }
});
