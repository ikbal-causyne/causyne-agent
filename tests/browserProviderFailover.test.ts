import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchPublicWeb } from '../src/browser/searchProviders.js';

test('lightweight providers use independent timeout signals and recover on fallback', async () => {
  const signals: AbortSignal[] = [];
  const results = await searchPublicWeb('recover search', {
    fetchImpl: async (_url, init) => {
      signals.push(init?.signal as AbortSignal);
      if (signals.length === 1) throw new Error('DuckDuckGo temporarily failed');
      return new Response('<rss><item><title>Working</title><link>https://example.org/</link><description>Found</description></item></rss>', { status: 200 });
    }
  });
  assert.equal(signals.length, 2);
  assert.notEqual(signals[0], signals[1]);
  assert.equal(results[0]?.url, 'https://example.org/');
});
