import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gameAssetHarvester } from '../src/tools/gameAssetHarvester.js';

test('asset harvester rejects output subdirectories escaping the project assets directory', async () => {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'causyne-asset-harvest-'));
  try {
    for (const targetSubdir of ['../../escape', '..', '../../../outside']) {
      const res = await gameAssetHarvester.execute({
        action: 'download_asset', projectDir: project, targetSubdir
      });
      assert.equal(res.success, false, targetSubdir);
      assert.match(res.error ?? '', /inside project assets/);
    }
  } finally { await fs.rm(project, { recursive: true, force: true }); }
});
