import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { streamAssetResponseToFile } from '../src/tools/gameAssetFetcher.js';

test('asset downloader rejects 200 OK HTML masquerading as ZIP archive', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'causyne-asset-zip-'));
  const target = path.join(root, 'archive.zip');
  try {
    await fs.writeFile(target, 'prior');
    await assert.rejects(
      streamAssetResponseToFile(new Response('<html>not a ZIP</html>'), target),
      /invalid file signature/
    );
    assert.equal(await fs.readFile(target,'utf8'),'prior');
    assert.deepEqual(await fs.readdir(root),['archive.zip']);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});

test('asset downloader validates ZIP signature across chunk boundaries', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'causyne-asset-zip-split-'));
  const target = path.join(root,'archive.zip');
  try {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([80]));
        controller.enqueue(new Uint8Array([75, 3]));
        controller.enqueue(new Uint8Array([4, 0]));
        controller.close();
      }
    });
    const size = await streamAssetResponseToFile(new Response(stream),target);
    assert.equal(size, 5);
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});
