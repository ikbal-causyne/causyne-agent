import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gameAssetFetcher } from '../src/tools/gameAssetFetcher.js';

test('asset downloader rejects oversized declared files before streaming', async () => {
  const before = globalThis.fetch;
  const originalUrl = 'https://kenney.nl/media/pages/assets/space-kit/f8c77efd5b-1662998797/kenney_space-kit.zip';
  globalThis.fetch = (async () => new Response(null, {
    status: 200,
    headers: { 'content-length': String(101 * 1024 * 1024) }
  })) as typeof fetch;
  try {
    const result = await gameAssetFetcher.execute({ action: 'download_asset', url: originalUrl });
    assert.equal(result.success, false);
    assert.match(result.error ?? '', /download limit/);
  } finally { globalThis.fetch = before; }
});
