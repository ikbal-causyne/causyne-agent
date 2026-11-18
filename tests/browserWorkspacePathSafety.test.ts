import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ensureSafeWorkspaceInputPath, ensureSafeWorkspaceOutputPath } from '../src/browser/workspacePathSafety.js';

test('workspace file checks reject symlink escapes for uploads and downloads', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'causyne-browser-path-'));
  const workspace = path.join(root, 'workspace');
  const outside = path.join(root, 'outside');
  try {
    await fs.mkdir(workspace);
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, 'secret.txt'), 'not in workspace');
    try {
      await fs.symlink(outside, path.join(workspace, 'escape'), 'dir');
      await fs.symlink(path.join(outside, 'secret.txt'), path.join(workspace, 'file-link'), 'file');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') { t.skip('Symlink creation is unavailable'); return; }
      throw error;
    }
    await assert.rejects(ensureSafeWorkspaceOutputPath(workspace, path.join(workspace, 'escape', 'nested', 'file.bin')), /outside/);
    await assert.rejects(ensureSafeWorkspaceOutputPath(workspace, path.join(workspace, 'file-link')), /symlink/);
    await assert.rejects(ensureSafeWorkspaceInputPath(workspace, path.join(workspace, 'file-link')), /outside/);
    await ensureSafeWorkspaceOutputPath(workspace, path.join(workspace, 'safe', 'nested', 'file.bin'));
    const stat = await fs.stat(path.join(workspace, 'safe', 'nested'));
    assert.equal(stat.isDirectory(), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
