import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gameAssetFetcher } from '../src/tools/gameAssetFetcher.js';

test('asset catalog search creates no output directories', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'causyne-catalog-readonly-'));
  const absent = path.join(workspace, 'should-not-exist');
  try {
    const result = await gameAssetFetcher.execute({ action: 'search_cc0', outputDir: absent });
    assert.equal(result.success, true);
    await assert.rejects(fs.stat(absent), /ENOENT/);
  } finally { await fs.rm(workspace, { recursive: true, force: true }); }
});
