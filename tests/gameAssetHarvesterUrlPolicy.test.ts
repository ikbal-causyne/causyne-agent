import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gameAssetHarvester } from '../src/tools/gameAssetHarvester.js';

test('asset harvester rejects local-network downloads without creating an asset', async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'causyne-asset-url-'));
  try {
    for (const assetUrl of ['http://127.0.0.1/private.obj', 'http://[::1]/internal.obj', 'file:///tmp/private.obj']) {
      const res = await gameAssetHarvester.execute({ action: 'download_asset', assetUrl, projectDir: project });
      assert.equal(res.success, false, assetUrl);
    }
  } finally { await fs.rm(project, { recursive: true, force: true }); }
});
