import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchPublicWeb } from '../src/browser/searchProviders.js';

test('external search cancellation is composed with the provider timeout', async () => {
  const caller = new AbortController();
  const capturedSignals: AbortSignal[] = [];
  const pending = searchPublicWeb('search cancel regression', {
    signal: caller.signal,
    fetchImpl: async (_input, init) => {
      const signal = init?.signal as AbortSignal;
      capturedSignals.push(signal);
      return new Promise<Response>((_resolve, reject) => {
        if (signal.aborted) { reject(new Error('provider aborted')); return; }
        signal.addEventListener('abort', () => reject(new Error('provider aborted')), { once: true });
      });
    }
  });
  caller.abort();
  await assert.rejects(pending, /provider aborted/);
  assert.ok(capturedSignals.length > 0);
  assert.notEqual(capturedSignals[0], caller.signal, 'caller signal must not bypass timeout signal');
  assert.equal(capturedSignals[0]?.aborted, true);
});
