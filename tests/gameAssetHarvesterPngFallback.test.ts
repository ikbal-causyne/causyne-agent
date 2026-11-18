import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gameAssetHarvester } from '../src/tools/gameAssetHarvester.js';

test('generated PNG fallback contains real PNG bytes rather than SVG data', async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'causyne-png-fallback-'));
  const before = globalThis.fetch;
  globalThis.fetch = (async () => new Response(null, { status: 404 })) as typeof fetch;
  try {
    const result = await gameAssetHarvester.execute({
      action: 'download_asset', projectDir, assetUrl: 'https://1.1.1.1/icon.png'
    });
    assert.equal(result.success, true);
    const { destination } = JSON.parse(result.output);
    const bytes = await fs.readFile(destination);
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  } finally { globalThis.fetch = before; await fs.rm(projectDir, { recursive: true, force: true }); }
});
