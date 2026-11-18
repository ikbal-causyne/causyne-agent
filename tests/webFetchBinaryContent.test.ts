import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { webFetch } from '../src/tools/webFetch.js';

test('binary HTTP responses cannot silently be reported as decoded UTF-8 text', async () => {
  const original = globalThis.fetch;
  const payload = new Uint8Array([0, 255, 128, 1, 2]);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'causyne-web-binary-'));
  globalThis.fetch = (async () => new Response(payload.slice(), {
    headers: { 'content-type': 'application/octet-stream' }
  })) as typeof fetch;
  try {
    const text = await webFetch.execute({ url: 'https://1.1.1.1/file.bin' });
    assert.equal(text.success, false);
    assert.match(text.error ?? '', /outputFile/);
    const file = await webFetch.execute({ url: 'https://1.1.1.1/file.bin', outputFile: 'file.bin' }, { workspaceRoot: dir });
    assert.equal(file.success, true);
    assert.deepEqual(await fs.readFile(path.join(dir, 'file.bin')), Buffer.from(payload));
  } finally {
    globalThis.fetch = original;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
