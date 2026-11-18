import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webFetch } from '../src/tools/webFetch.js';

test('303 redirects preserve HEAD and 307 redirects preserve POST body', async () => {
  const originalFetch = globalThis.fetch;
  const observed: Array<{method: string | undefined; body: unknown }> = [];
  let redirectCode = 303;
  globalThis.fetch = (async (_input: URL | RequestInfo, init?: RequestInit) => {
    observed.push({ method: init?.method, body: init?.body });
    return observed.length % 2 === 1
      ? new Response(null, { status: redirectCode, headers: { Location: '/next' } })
      : new Response(null, { status: 200 });
  }) as typeof fetch;
  try {
    assert.equal((await webFetch.execute({ url: 'https://1.1.1.1/start', method: 'HEAD' })).success, true);
    assert.deepEqual(observed.slice(0, 2).map(c => c.method), ['HEAD', 'HEAD']);
    redirectCode = 307;
    assert.equal((await webFetch.execute({ url: 'https://1.1.1.1/start', method: 'POST', body: 'payload' })).success, true);
    assert.deepEqual(observed.slice(2).map(c => [c.method, c.body]), [['POST', 'payload'], ['POST', 'payload']]);
  } finally { globalThis.fetch = originalFetch; }
});
