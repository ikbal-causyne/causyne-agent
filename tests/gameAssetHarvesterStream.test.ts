import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gameAssetHarvester } from '../src/tools/gameAssetHarvester.js';

test('asset harvester downloads through the safe bounded web-fetch path', async () => {
  const projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'causyne-harvest-stream-'));
  const before = globalThis.fetch;
  const mockAsset = '# valid OBJ file\nv 0 0 0\n';
  globalThis.fetch = (async () => new Response(mockAsset, { status: 200 })) as typeof fetch;
  try {
    const result = await gameAssetHarvester.execute({
      action: 'download_asset', projectDir, assetUrl: 'https://1.1.1.1/figure.obj', targetSubdir: 'models'
    });
    assert.equal(result.success, true);
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.download_result.source, 'downloaded');
    assert.equal(await fs.readFile(path.join(projectDir, 'assets', 'models', 'figure.obj'), 'utf8'), mockAsset);
  } finally {
    globalThis.fetch = before;
    await fs.rm(projectDir, { recursive: true, force: true });
  }
});
