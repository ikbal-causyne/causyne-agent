import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkspacePreview } from '../src/browser/workspacePreview.js';

test('workspace preview registration remains bounded across repeated opens', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'causyne-preview-limit-'));
  try {
    await fs.writeFile(path.join(root, 'index.html'), '<h1>hello</h1>');
    const preview = new WorkspacePreview();
    const opened: string[] = [];
    for (let i = 0; i < 130; i++) opened.push(await preview.open(root, 'index.html'));
    assert.equal(await preview.response(opened[0]!), null);
    assert.equal((await preview.response(opened[129]!))?.status, 200);
    preview.clear();
    assert.equal(await preview.response(opened[129]!), null);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
