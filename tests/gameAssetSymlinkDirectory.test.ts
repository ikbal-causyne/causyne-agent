import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gameAssetHarvester } from '../src/tools/gameAssetHarvester.js';

test('single asset download cannot create directories through a workspace symlink', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'causyne-harvest-symlink-'));
  const projectDir = path.join(base, 'project');
  const outside = path.join(base, 'outside');
  try {
    await fs.mkdir(projectDir);
    await fs.mkdir(outside);
    try { await fs.symlink(outside, path.join(projectDir, 'assets'), 'dir'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('symlinks unavailable'); return; }
      throw error;
    }
    const result = await gameAssetHarvester.execute({
      action:'download_asset', projectDir, assetUrl:'https://1.1.1.1/icon.obj',
      targetSubdir:'nested/private'
    });
    assert.equal(result.success, false);
    await assert.rejects(fs.stat(path.join(outside, 'nested')), /ENOENT/);
  } finally { await fs.rm(base, {recursive:true,force:true}); }
});
