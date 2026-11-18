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

test('starter pack never reports all downloads when an asset failed', () => {
  const outcome = summarizeHarvestResults([
    { status: { source: 'downloaded' } },
    { status: { source: 'download_failed', success: false } }
  ]);
  assert.equal(outcome.status, 'STARTER_PACK_INCOMPLETE');
  assert.equal(outcome.downloaded_count, 1);
  assert.equal(outcome.failed_count, 1);
});
