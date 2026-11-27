import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
import { atomicWriteFileSync, atomicWriteFile, atomicRenameSync, atomicRename } from '../src/infra/atomicWriter.js';

test('atomic writer handles partial synchronous writes', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-short-write-'));
  const target = path.join(dir, 'out');
  const payload = Buffer.from('0123456789abcdef');
  const original = fs.writeSync;
  const fake = t.mock.method(fs, 'writeSync', (fd, buffer, offset, length, position) => {
    return original(fd, buffer, offset, Math.min(length, 3), position);
  });
  syncBuiltinESMExports();
  try {
    atomicWriteFileSync(target, payload);
    assert.deepEqual(fs.readFileSync(target), payload);
    assert.ok(fake.mock.callCount() > 1);
  } finally {
    fake.mock.restore();
    syncBuiltinESMExports();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('invalid Windows rename retry limits remain bounded', async (t) => {
  const err = Object.assign(new Error('locked'), { code: 'EPERM' });
  const sync = t.mock.method(fs, 'renameSync', () => { throw err; });
  const asyncRename = t.mock.method(fsPromises, 'rename', async () => { throw err; });
  syncBuiltinESMExports();
  try {
    assert.throws(() => atomicRenameSync('a', 'b', { platform: 'win32', maxRetries: NaN }), { code: 'EPERM' });
    assert.equal(sync.mock.callCount(), 6);
    await assert.rejects(atomicRename('a', 'b', { platform: 'win32', maxRetries: Infinity }), { code: 'EPERM' });
    assert.equal(asyncRename.mock.callCount(), 6);
  } finally {
    sync.mock.restore();
    asyncRename.mock.restore();
    syncBuiltinESMExports();
  }
});

test('asynchronous atomic writes do not call the synchronous writer', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-async-write-'));
  const target = path.join(dir, 'out');
  const fake = t.mock.method(fs, 'openSync', () => { throw new Error('unexpected synchronous open'); });
  syncBuiltinESMExports();
  try {
    await atomicWriteFile(target, 'new content');
    assert.equal(fake.mock.callCount(), 0);
  } finally {
    fake.mock.restore();
    syncBuiltinESMExports();
    try { assert.equal(fs.readFileSync(target, 'utf8'), 'new content'); }
    finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
});
