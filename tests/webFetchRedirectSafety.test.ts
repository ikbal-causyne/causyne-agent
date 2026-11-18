import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webFetch } from '../src/tools/webFetch.js';

test('web.fetch strips cookies and authorization when redirect crosses origins', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; headers: Headers }> = [];
  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ url: String(input), headers: new Headers(init?.headers) });
    if (calls.length === 1) return new Response(null, { status: 302, headers: { Location: 'https://8.8.8.8/result' } });
    return new Response('ok', { status: 200 });
  }) as typeof fetch;
  try {
    const result = await webFetch.execute({ url: 'https://1.1.1.1/start', headers: {
      Authorization: 'Bearer secret', Cookie: 'session=secret', 'X-Trace': 'retained'
    } });
    assert.equal(result.success, true);
    assert.equal(calls.length, 2);
    assert.equal(calls[0]?.headers.get('authorization'), 'Bearer secret');
    assert.equal(calls[1]?.headers.has('authorization'), false);
    assert.equal(calls[1]?.headers.has('cookie'), false);
    assert.equal(calls[1]?.headers.get('x-trace'), 'retained');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
