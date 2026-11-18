import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { webFetch } from '../src/tools/webFetch.js';

test('web.fetch downloads stay within canonical workspace boundaries', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'causyne-web-download-'));
  const workspace = path.join(root, 'workspace');
  const outside = path.join(root, 'outside');
  const originalFetch = globalThis.fetch;
  try {
    await fs.mkdir(workspace);
    await fs.mkdir(outside);
    try { await fs.symlink(outside, path.join(workspace, 'escape'), 'dir'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('Symlink unavailable'); return; }
      throw error;
    }
    globalThis.fetch = (async () => new Response('download body')) as typeof fetch;
    const escaped = await webFetch.execute(
      { url: 'https://1.1.1.1/test', outputFile: 'escape/out.bin' },
      { workspaceRoot: workspace }
    );
    assert.equal(escaped.success, false);
    await assert.rejects(fs.stat(path.join(outside, 'out.bin')), /ENOENT/);
    const valid = await webFetch.execute(
      { url: 'https://1.1.1.1/test', outputFile: 'downloads/file.bin' },
      { workspaceRoot: workspace }
    );
    assert.equal(valid.success, true);
    assert.equal(await fs.readFile(path.join(workspace, 'downloads', 'file.bin'), 'utf8'), 'download body');
  } finally {
    globalThis.fetch = originalFetch;
    await fs.rm(root, { recursive: true, force: true });
  }
});
