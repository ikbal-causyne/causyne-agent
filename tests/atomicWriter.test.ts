import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { atomicWriteFileSync, atomicWriteFile } from '../src/infra/atomicWriter.js';

describe('atomicWriter', () => {
  it('writes text files atomically', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-atomic-'));
    const target = path.join(tmpDir, 'subdir', 'test.txt');

    atomicWriteFileSync(target, 'atomic content test');
    assert.ok(fs.existsSync(target));
    assert.equal(fs.readFileSync(target, 'utf8'), 'atomic content test');

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes buffers atomically with async method', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-atomic-'));
    const target = path.join(tmpDir, 'buffer.bin');
    const buf = Buffer.from([1, 2, 3, 4, 5]);

    await atomicWriteFile(target, buf);
    assert.ok(fs.existsSync(target));
    assert.deepEqual(fs.readFileSync(target), buf);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
