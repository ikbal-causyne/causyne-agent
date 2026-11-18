import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gameAssetHarvester } from '../src/tools/gameAssetHarvester.js';

test('asset catalog searches combine category and keyword instead of matching every item in category', async () => {
  const defaults = JSON.parse((await gameAssetHarvester.execute({
    action: 'search_assets', query: 'dungeon'
  })).output);
  assert.deepEqual(defaults.items.map((item: { id: string }) => item.id), ['kenney_dungeon_tiles']);
  const mismatch = JSON.parse((await gameAssetHarvester.execute({
    action: 'search_assets', category: '3d_model', query: 'dungeon'
  })).output);
  assert.equal(mismatch.results_count, 0);
  const match = JSON.parse((await gameAssetHarvester.execute({
    action: 'search_assets', category: '3d_model', query: 'knight'
  })).output);
  assert.equal(match.results_count, 1);
});
