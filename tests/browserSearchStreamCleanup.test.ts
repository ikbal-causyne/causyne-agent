import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchPublicWeb } from '../src/browser/searchProviders.js';

test('search provider HTTP error bodies are cancelled before switching providers', async () => {
  let cancelled = 0;
  let requests = 0;
  const results = await searchPublicWeb('provider response cleanup', {
    fetchImpl: async () => {
      requests++;
      if (requests === 1) {
        return new Response(new ReadableStream({ cancel() { cancelled++; } }), { status: 503 });
      }
      return new Response('<rss><item><title>Recovered</title><link>https://example.org/ok</link></item></rss>');
    }
  });
  assert.equal(cancelled, 1);
  assert.equal(requests, 2);
  assert.equal(results[0]?.url, 'https://example.org/ok');
});
