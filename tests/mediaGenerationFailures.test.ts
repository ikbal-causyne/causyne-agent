import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateMediaViaApi } from '../src/tools/generateMediaViaApi.js';
import { saveConfig } from '../src/config.js';

test('media validation and authentication failures make no network request or output artifact', async () => {
  saveConfig({ provider: 'antigravity', autonomyMode: 'C' });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-media-invalid-'));
  const outputPath = path.join(directory, 'image.png');
  const original = globalThis.fetch;
  const key = process.env.POLLINATIONS_API_KEY;
  delete process.env.POLLINATIONS_API_KEY;
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error('No network allowed'); };
  try {
    const invalid = await generateMediaViaApi.execute({});
    assert.equal(invalid.code, 'INVALID_TOOL_ARGUMENTS');
    const missingKey = await generateMediaViaApi.execute({ mediaType: 'image', prompt: 'Ocean and stars', outputPath });
    assert.equal(missingKey.code, 'MEDIA_AUTH_REQUIRED');
    assert.equal(missingKey.success, false);
    assert.equal(requests, 0);
    assert.equal(fs.existsSync(outputPath), false);
  } finally {
    globalThis.fetch = original;
    if (key !== undefined) process.env.POLLINATIONS_API_KEY = key;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('HTTP 402 stops after one request, sends credentials in headers, and never creates an artifact', async () => {
  saveConfig({ provider: 'antigravity', autonomyMode: 'C', pollinationsApiKey: 'fixture-key-not-a-secret' });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-media-payment-'));
  const outputPath = path.join(directory, 'image.png');
  const original = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async (url, init) => {
    requests++;
    assert.match(String(url), /^https:\/\/gen.pollinations.ai\/image\//);
    assert.doesNotMatch(String(url), /fixture-key/);
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-key-not-a-secret');
    return new Response('', { status: 402 });
  };
  try {
    const result = await generateMediaViaApi.execute({ mediaType: 'image', prompt: 'Ocean and stars', outputPath });
    assert.equal(result.status, 402);
    assert.equal(result.retryable, false);
    assert.equal(result.attempts, 1);
    assert.equal(result.success, false);
    assert.equal(requests, 1);
    assert.equal(fs.existsSync(outputPath), false);
  } finally { globalThis.fetch = original; fs.rmSync(directory, { recursive: true, force: true }); }
});
