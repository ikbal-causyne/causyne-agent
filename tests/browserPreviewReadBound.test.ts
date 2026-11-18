import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readBoundedPreviewFile, WorkspacePreview } from '../src/browser/workspacePreview.js';

test('preview asset reading honors size caps and maintains exact file bytes', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'causyne-preview-bounded-'));
  try {
    const file = path.join(root, 'index.html');
    const bytes = Buffer.from([0, 255, 1, 2, 3]);
    await fs.writeFile(file, bytes);
    assert.equal(await readBoundedPreviewFile(file, 4), null);
    assert.deepEqual(await readBoundedPreviewFile(file, 5), bytes);
    const preview = new WorkspacePreview();
    const url = await preview.open(root, 'index.html');
    const response = await preview.response(url);
    assert.equal(response?.status, 200);
    assert.deepEqual(response?.body, bytes);
  } finally { await fs.rm(root, {recursive:true,force:true}); }
});
