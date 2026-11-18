import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gameAssetFetcher } from '../src/tools/gameAssetFetcher.js';

test('asset synthesizer refuses to write outside sandbox via directory symlinks', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'causyne-asset-output-'));
  const workspaceRoot = path.join(dir, 'ws');
  const outside = path.join(dir, 'outside');
  try {
    await fs.mkdir(workspaceRoot);
    await fs.mkdir(outside);
    try { await fs.symlink(outside, path.join(workspaceRoot, 'escape'), 'dir'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('symlinks unavailable'); return; }
      throw error;
    }
    const result = await gameAssetFetcher.execute({
      action: 'synth_wav', preset: 'coin', outputDir: path.join(workspaceRoot, 'escape'), outputFilename: 'coin.wav'
    }, { workspaceRoot, isPathAllowed: () => true });
    assert.equal(result.success, false);
    await assert.rejects(fs.stat(path.join(outside, 'coin.wav')), /ENOENT/);
    const safe = await gameAssetFetcher.execute({
      action: 'synth_wav', preset: 'coin', outputDir: path.join(workspaceRoot, 'audio')
    }, { workspaceRoot, isPathAllowed: () => true });
    assert.equal(safe.success, true);
    const data = await fs.readFile(path.join(workspaceRoot, 'audio', 'sfx_coin.wav'));
    assert.equal(data.subarray(0, 4).toString(), 'RIFF');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
