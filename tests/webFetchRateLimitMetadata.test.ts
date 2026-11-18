import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webFetch } from '../src/tools/webFetch.js';

test('HTTP rate limit returns explicit retry metadata without browser fallback', async () => {
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = (async () => {
    requests++;
    return new Response('<h1>Too many requests</h1>', {
      status: 429, headers:{'content-type':'text/html','retry-after':'120'}
    });
  }) as typeof fetch;
  try {
    const result = await webFetch.execute({url:'https://1.1.1.1/limited'});
    assert.equal(result.success,false);
    assert.equal(result.failureKind,'rate_limited');
    assert.equal(result.retryAfter,'120');
    assert.equal(requests,1);
  } finally { globalThis.fetch=original; }
});
