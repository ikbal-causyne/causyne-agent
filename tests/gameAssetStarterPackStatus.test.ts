import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeHarvestResults } from '../src/tools/gameAssetHarvester.js';

test('starter pack summary reports procedural fallbacks separately from real downloads', () => {
  const result = summarizeHarvestResults([
    { status: { source: 'downloaded' } },
    { status: { source: 'procedural_cc0_fallback' } },
    { status: { source: 'downloaded' } }
  ]);
  assert.equal(result.status, 'STARTER_PACK_WITH_PROCEDURAL_FALLBACKS');
  assert.equal(result.downloaded_count, 2);
  assert.equal(result.fallback_count, 1);
  assert.equal(summarizeHarvestResults([{ status: { source: 'downloaded' } }]).status, 'STARTER_PACK_DOWNLOADED');
});
