import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webFetch } from '../src/tools/webFetch.js';

test('web.fetch cancels unread error and oversized bodies', async () => {
  const originalFetch = globalThis.fetch;
  let cancelled = 0;
  let status = 404;
  globalThis.fetch = (async () => {
    const body = new ReadableStream({ cancel() { cancelled++; } });
    return status === 404
      ? new Response(body, { status })
      : new Response(body, { status: 200, headers: { 'content-length': String(60 * 1024 * 1024) } });
  }) as typeof fetch;
  try {
    const notFound = await webFetch.execute({ url: 'https://1.1.1.1/not-found' });
    assert.equal(notFound.success, false);
    assert.equal(cancelled, 1);
    status = 200;
    const tooLarge = await webFetch.execute({ url: 'https://1.1.1.1/large' });
    assert.equal(tooLarge.success, false);
    assert.equal(cancelled, 2);
  } finally { globalThis.fetch = originalFetch; }
});
