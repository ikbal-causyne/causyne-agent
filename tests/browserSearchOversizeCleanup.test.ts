import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchPublicWeb } from '../src/browser/searchProviders.js';

test('oversized search provider responses are cancelled before trying a fallback', async () => {
  let cancelled = 0;
  let count = 0;
  const results = await searchPublicWeb('oversized provider', {
    fetchImpl: async () => {
      if (++count === 1) {
        return new Response(new ReadableStream({ cancel() { cancelled++; } }), {
          headers: { 'content-length': String(3 * 1024 * 1024) }
        });
      }
      return new Response('<rss><item><title>Result</title><link>https://example.com/ok</link></item></rss>');
    }
  });
  assert.equal(cancelled, 1);
  assert.equal(count, 2);
  assert.equal(results[0]?.url, 'https://example.com/ok');
});
