import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { streamAssetResponseToFile } from '../src/tools/gameAssetFetcher.js';

test('asset streaming writes exact bytes atomically without buffering an entire asset', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'causyne-stream-asset-'));
  try {
    const target = path.join(dir, 'sample.bin');
    const source = new Response(new Uint8Array([0, 255, 3, 4, 7]));
    const count = await streamAssetResponseToFile(source, target, 5);
    assert.equal(count, 5);
    assert.deepEqual(await fs.readFile(target), Buffer.from([0, 255, 3, 4, 7]));
    assert.deepEqual(await fs.readdir(dir), ['sample.bin']);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('oversized asset stream cancels and preserves previous destination without partial files', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'causyne-stream-cap-'));
  try {
    const target = path.join(dir, 'sample.bin');
    await fs.writeFile(target, 'previous');
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5, 6]));
      },
      cancel() { cancelled = true; }
    });
    await assert.rejects(
      streamAssetResponseToFile(new Response(stream), target, 5),
      /Asset exceeds/
    );
    assert.equal(cancelled, true);
    assert.equal(await fs.readFile(target, 'utf8'), 'previous');
    assert.deepEqual(await fs.readdir(dir), ['sample.bin']);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
