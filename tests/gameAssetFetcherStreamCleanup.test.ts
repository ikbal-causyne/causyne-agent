import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gameAssetFetcher } from '../src/tools/gameAssetFetcher.js';

test('asset fetcher releases rejected and declared-oversized response streams', async () => {
  const before = globalThis.fetch;
  let cancelled = 0;
  let status = 503;
  globalThis.fetch = (async () => {
    const stream = new ReadableStream({ cancel() { cancelled++; } });
    return status === 503 ? new Response(stream, { status: 503 }) :
      new Response(stream, { status: 200, headers: { 'content-length': String(101 * 1024 * 1024) } });
  }) as typeof fetch;
  const args = {
    action: 'download_asset',
    url: 'https://kenney.nl/media/pages/assets/space-kit/f8c77efd5b-1662998797/kenney_space-kit.zip'
  };
  try {
    assert.equal((await gameAssetFetcher.execute(args)).success, false);
    assert.equal(cancelled, 1);
    status = 200;
    assert.equal((await gameAssetFetcher.execute(args)).success, false);
    assert.equal(cancelled, 2);
  } finally { globalThis.fetch = before; }
});
