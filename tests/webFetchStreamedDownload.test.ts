import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { writeResponseBodyAtomically, webFetch } from '../src/tools/webFetch.js';

test('bounded web download streams to an atomic file without buffering the complete payload', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'causyne-web-atomic-stream-'));
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(new Uint8Array([0, 255, 1, 2, 3]))) as typeof fetch;
  try {
    const result = await webFetch.execute({url:'https://1.1.1.1/file',outputFile:'docs/file.bin'}, {workspaceRoot:root});
    assert.equal(result.success, true);
    assert.deepEqual(await fs.readFile(path.join(root,'docs','file.bin')),Buffer.from([0,255,1,2,3]));
    assert.deepEqual(await fs.readdir(path.join(root,'docs')),['file.bin']);
  } finally { globalThis.fetch = original; await fs.rm(root, {recursive:true,force:true}); }
});

test('oversized web download stream cleans up partial files without touching existing output', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'causyne-web-atomic-overflow-'));
  try {
    const target = path.join(root,'existing.bin');
    await fs.writeFile(target,'keep');
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(ctrl) { ctrl.enqueue(new Uint8Array([1,2,3])); ctrl.enqueue(new Uint8Array([4,5,6])); },
      cancel() { cancelled = true; }
    });
    await assert.rejects(writeResponseBodyAtomically(new Response(stream),root,target,5),/Response exceeds/);
    assert.equal(cancelled,true);
    assert.equal(await fs.readFile(target,'utf8'),'keep');
    assert.deepEqual(await fs.readdir(root),['existing.bin']);
  } finally { await fs.rm(root, {recursive:true,force:true}); }
});
