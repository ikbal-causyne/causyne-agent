import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gameAssetHarvester } from '../src/tools/gameAssetHarvester.js';

test('starter asset packs never create files or directories through an escaping assets symlink', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'causyne-pack-symlink-'));
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
    const result = await gameAssetHarvester.execute({ action:'harvest_starter_pack', projectDir });
    assert.equal(result.success, false);
    assert.deepEqual(await fs.readdir(outside), []);
  } finally { await fs.rm(base, {recursive:true,force:true}); }
});
