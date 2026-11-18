import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gameAssetFetcher } from '../src/tools/gameAssetFetcher.js';

test('synthesized assets replace files atomically without leaving partial files', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'causyne-asset-atomic-'));
  try {
    await fs.writeFile(path.join(root, 'tone.wav'), 'old');
    const result = await gameAssetFetcher.execute({
      action: 'synth_wav', preset: 'hit', outputFilename: 'tone.wav', outputDir: root
    });
    assert.equal(result.success, true);
    assert.equal((await fs.readFile(path.join(root, 'tone.wav'))).subarray(0, 4).toString(), 'RIFF');
    assert.deepEqual(await fs.readdir(root), ['tone.wav']);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
