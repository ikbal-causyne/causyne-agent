import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gameAssetFetcher } from '../src/tools/gameAssetFetcher.js';

test('curated asset requests carry a bounded abort signal', async () => {
  const oldFetch = globalThis.fetch;
  let signal: AbortSignal | undefined;
  globalThis.fetch = (async (_url, options) => {
    signal = options?.signal as AbortSignal;
    return new Response(null, { status: 503 });
  }) as typeof fetch;
  try {
    const result = await gameAssetFetcher.execute({
      action: 'download_asset',
      url: 'https://kenney.nl/media/pages/assets/space-kit/f8c77efd5b-1662998797/kenney_space-kit.zip'
    });
    assert.equal(result.success, false);
    assert.ok(signal instanceof AbortSignal);
    assert.equal(signal.aborted, false);
  } finally { globalThis.fetch = oldFetch; }
});
