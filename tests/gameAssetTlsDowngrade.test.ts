import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gameAssetFetcher } from '../src/tools/gameAssetFetcher.js';

test('curated asset downloads reject redirects from HTTPS to HTTP', async () => {
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response(null, {status:301,headers:{location:'http://8.8.8.8/asset.zip'}});
  }) as typeof fetch;
  try {
    const result = await gameAssetFetcher.execute({
      action:'download_asset',
      url:'https://kenney.nl/media/pages/assets/space-kit/f8c77efd5b-1662998797/kenney_space-kit.zip'
    });
    assert.equal(result.success, false);
    assert.match(result.error ?? '', /downgrade HTTPS/);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = previous; }
});
