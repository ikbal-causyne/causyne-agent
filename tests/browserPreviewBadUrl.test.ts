import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkspacePreview } from '../src/browser/workspacePreview.js';

test('malformed browser interception URLs fail closed without throwing', async () => {
  const preview = new WorkspacePreview();
  for (const input of ['', 'not a URL', 'http://[', '://broken']) {
    assert.equal(await preview.response(input), null);
  }
});

test('preview rejects directories named like HTML files', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'causyne-preview-directory-'));
  try {
    await fs.mkdir(path.join(root, 'index.html'));
    const preview = new WorkspacePreview();
    await assert.rejects(preview.open(root, 'index.html'), /regular HTML file/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
