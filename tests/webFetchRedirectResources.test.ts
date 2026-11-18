import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webFetch } from '../src/tools/webFetch.js';

test('web.fetch releases redirect bodies when Location is absent or redirect cap is reached', async () => {
  const original = globalThis.fetch;
  let cancellations = 0;
  let withLocation = false;
  globalThis.fetch = (async () => new Response(new ReadableStream({ cancel() { cancellations++; } }), {
    status: 302,
    headers: withLocation ? { Location: '/loop' } : {}
  })) as typeof fetch;
  try {
    const absent = await webFetch.execute({ url: 'https://1.1.1.1/start' });
    assert.equal(absent.success, false);
    assert.match(absent.error ?? '', /Location/);
    assert.equal(cancellations, 1);
    withLocation = true;
    const looping = await webFetch.execute({ url: 'https://1.1.1.1/loop' });
    assert.equal(looping.success, false);
    assert.match(looping.error ?? '', /Too many redirects/);
    assert.equal(cancellations, 7);
  } finally { globalThis.fetch = original; }
});
