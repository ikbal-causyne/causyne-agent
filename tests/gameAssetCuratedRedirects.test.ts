import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gameAssetFetcher } from '../src/tools/gameAssetFetcher.js';

const curatedUrl = 'https://kenney.nl/media/pages/assets/space-kit/f8c77efd5b-1662998797/kenney_space-kit.zip';

test('curated downloader rejects redirects to local services without requesting them', async () => {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async input => {
    calls.push(String(input));
    return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } });
  }) as typeof fetch;
  try {
    const result = await gameAssetFetcher.execute({action:'download_asset',url:curatedUrl});
    assert.equal(result.success, false);
    assert.match(result.error ?? '', /private|reserved|Local|network/i);
    assert.equal(calls.length, 1);
  } finally { globalThis.fetch = original; }
});

test('curated downloader follows safe public redirects with a bounded chain', async () => {
  const original = globalThis.fetch;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'causyne-curated-redirect-'));
  const calls: string[] = [];
  globalThis.fetch = (async input => {
    calls.push(String(input));
    return calls.length === 1
      ? new Response(null, {status:302,headers:{location:'https://1.1.1.1/assets.zip'}})
      : new Response(new Uint8Array([1, 2, 3]), {status:200});
  }) as typeof fetch;
  try {
    const result = await gameAssetFetcher.execute({action:'download_asset',url:curatedUrl, outputDir:directory});
    assert.equal(result.success, true);
    assert.equal(calls.length, 2);
    const output = JSON.parse(result.output);
    assert.deepEqual(await fs.readFile(output.output_file), Buffer.from([1, 2, 3]));
  } finally {
    globalThis.fetch = original;
    await fs.rm(directory, {recursive:true,force:true});
  }
});
