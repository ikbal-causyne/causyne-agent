import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isBinaryResponseContentType, webFetch } from '../src/tools/webFetch.js';

test('binary MIME classification handles documents, archives, fonts, and structured text', () => {
  const binary = ['application/pdf', 'application/x-zip-compressed', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/wasm', 'font/woff2', 'video/mp4', 'image/png'];
  const readable = ['text/html; charset=utf-8', 'application/json', 'application/problem+json', 'application/rss+xml', 'image/svg+xml', 'text/css'];
  for (const mime of binary) assert.equal(isBinaryResponseContentType(mime), true, mime);
  for (const mime of readable) assert.equal(isBinaryResponseContentType(mime), false, mime);
});

test('web.fetch refuses to corrupt binary office documents into text', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response(new Uint8Array([80, 75, 3, 4]), {
    headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }
  })) as typeof fetch;
  try {
    const result = await webFetch.execute({url: 'https://1.1.1.1/report.docx'});
    assert.equal(result.success, false);
    assert.match(result.error ?? '', /Binary content requires outputFile/);
  } finally { globalThis.fetch = original; }
});
