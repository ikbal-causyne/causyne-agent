import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gameAssetFetcher } from '../src/tools/gameAssetFetcher.js';

test('curated archive downloads cannot be relabeled as ready-to-use models', async () => {
  const result = await gameAssetFetcher.execute({
    action:'download_asset',
    url:'https://kenney.nl/media/pages/assets/space-kit/f8c77efd5b-1662998797/kenney_space-kit.zip',
    outputFilename:'game_model.obj'
  });
  assert.equal(result.success,false);
  assert.match(result.error ?? '',/preserve its source file extension/);
});
