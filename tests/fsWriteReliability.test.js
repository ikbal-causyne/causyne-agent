import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fsWrite } from '../src/tools/fsWrite.js';

async function inTempDir(fn) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'causyne-write-test-'));
  try { return await fn(root); } finally { await fs.rm(root, { recursive: true, force: true }); }
}

test('rejects directory target without corrupting directory or leaving temp', () => inTempDir(async root => {
  const target = path.join(root, 'horse-robot');
  await fs.mkdir(target);
  const result = await fsWrite.execute({ path: target, content: 'bad' }, { workspacePaths: [root] });
  assert.equal(result.success, false);
  assert.match(result.error, /directory/i);
  assert.equal((await fs.stat(target)).isDirectory(), true);
  assert.deepEqual(await fs.readdir(root), ['horse-robot']);
}));

test('writes a nested filename within selected workspace and allows overwrite', () => inTempDir(async root => {
  const target = path.join(root, 'horse-robot', 'index.html');
  const context = { workspacePaths: [root] };
  assert.equal((await fsWrite.execute({ path: target, content: '<html>1</html>' }, context)).success, true);
  assert.equal(await fs.readFile(target, 'utf8'), '<html>1</html>');
  assert.equal((await fsWrite.execute({ path: target, content: '<html>2</html>' }, context)).success, true);
  assert.equal(await fs.readFile(target, 'utf8'), '<html>2</html>');
  assert.equal((await fs.readdir(path.dirname(target))).length, 1);
}));

test('rejects missing arguments instead of inventing content', () => inTempDir(async root => {
  assert.equal((await fsWrite.execute({ path: root })).success, false);
  assert.equal((await fsWrite.execute({ path: '', content: 'x' })).success, false);
  assert.equal((await fsWrite.execute({ path: `${root}/`, content: 'x' })).success, false);
}));

test('rejects symlinked parent escaping workspace', () => inTempDir(async root => {
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'causyne-write-outside-'));
  try {
    await fs.symlink(outside, path.join(root, 'linked'), 'dir');
    const target = path.join(root, 'linked', 'escape.js');
    const result = await fsWrite.execute({ path: target, content: 'secret' }, { workspacePaths: [root] });
    assert.equal(result.success, false);
    await assert.rejects(fs.readFile(path.join(outside, 'escape.js'), 'utf8'), { code: 'ENOENT' });
  } finally { await fs.rm(outside, { recursive: true, force: true }); }
}));

test('rejects symlinked destination even when symlink is inside workspace', () => inTempDir(async root => {
  await fs.writeFile(path.join(root, 'target.txt'), 'keep');
  await fs.symlink(path.join(root, 'target.txt'), path.join(root, 'link.txt'));
  const result = await fsWrite.execute({ path: path.join(root, 'link.txt'), content: 'replace' }, { workspacePaths: [root] });
  assert.equal(result.success, false);
  assert.equal(await fs.readFile(path.join(root, 'target.txt'), 'utf8'), 'keep');
}));