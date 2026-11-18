import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webFetch } from '../src/tools/webFetch.js';

test('HTTP 401 reports authentication required without silently switching to a browser', async () => {
  const original = globalThis.fetch;
  let count = 0;
  globalThis.fetch = (async () => {
    count++;
    return new Response('<h1>Sign in</h1>', {
      status:401,headers:{'content-type':'text/html'}
    });
  }) as typeof fetch;
  try {
    const result = await webFetch.execute({url:'https://1.1.1.1/account'});
    assert.equal(result.success,false);
    assert.equal(result.failureKind,'authentication_required');
    assert.equal(count,1);
    assert.match(result.error ?? '',/requires authentication/);
  } finally { globalThis.fetch=original; }
});
