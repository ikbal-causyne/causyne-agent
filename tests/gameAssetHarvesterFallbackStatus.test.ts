import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gameAssetHarvester } from '../src/tools/gameAssetHarvester.js';

test('asset harvester distinguishes procedural fallbacks from actual downloads', async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'causyne-harvest-fallback-'));
  const before = globalThis.fetch;
  globalThis.fetch = (async () => new Response('not found', { status: 404 })) as typeof fetch;
  try {
    const result = await gameAssetHarvester.execute({
      action: 'download_asset', projectDir, assetUrl: 'https://1.1.1.1/unavailable.obj'
    });
    assert.equal(result.success, true);
    const output = JSON.parse(result.output);
    assert.equal(output.status, 'PROCEDURAL_FALLBACK_GENERATED');
    assert.equal(output.downloaded, false);
    assert.equal(output.download_result.source, 'procedural_cc0_fallback');
    assert.ok(output.download_result.downloadError);
    assert.ok((await fs.readFile(output.destination, 'utf8')).includes('v -0.5'));
  } finally { globalThis.fetch = before; await fs.rm(projectDir, { recursive: true, force: true }); }
});
