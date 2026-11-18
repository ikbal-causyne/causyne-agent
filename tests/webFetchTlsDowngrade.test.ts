import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webFetch } from '../src/tools/webFetch.js';

test('web.fetch rejects transport-security downgrade on redirect', async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(null, {status:302,headers:{location:'http://8.8.8.8/untrusted'}});
  }) as typeof fetch;
  try {
    const result = await webFetch.execute({url:'https://1.1.1.1/start'});
    assert.equal(result.success, false);
    assert.match(result.error ?? '', /redirect downgrade/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});
