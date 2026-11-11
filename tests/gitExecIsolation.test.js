import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { gitExec, parseGitArguments } from '../src/tools/gitExec.js';

test('Git arguments preserve quoted messages and literal Windows paths', () => {
  assert.deepEqual(parseGitArguments('commit -m "fix: preserve message spaces"'),
    ['commit', '-m', 'fix: preserve message spaces']);
  assert.deepEqual(parseGitArguments('status --short'), ['status', '--short']);
  assert.deepEqual(parseGitArguments(String.raw`show C:\Users\example\file.txt`),
    ['show', String.raw`C:\Users\example\file.txt`]);
  assert.throws(() => parseGitArguments('status && echo unexpected'), /shell operators/);
  assert.throws(() => parseGitArguments('status; touch marker'), /shell operators/);
  assert.throws(() => parseGitArguments('status `whoami`'), /shell operators/);
  assert.throws(() => parseGitArguments('status "unterminated'), /Unterminated quote/);
  assert.throws(() => parseGitArguments(''), /required/);
});

test('gitOp never delegates a chained Git command to the OS shell', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-git-exec-'));
  const marker = path.join(workspace, 'unexpected-marker');
  try {
    execFileSync('git', ['init', '-q'], { cwd: workspace });
    const safe = await gitExec.execute({ command: 'status --short', cwd: workspace });
    assert.equal(safe.success, true, safe.error);
    const chained = await gitExec.execute({
      command: `status && node -e "require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'unexpected')"`,
      cwd: workspace
    });
    assert.equal(chained.success, false);
    assert.match(chained.error, /shell operators/);
    assert.equal(fs.existsSync(marker), false);
    const quoted = await gitExec.execute({ command: 'log -1 --format="%h %s"', cwd: workspace });
    assert.equal(quoted.success, false, 'empty repositories should not pretend a Git log succeeded');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
