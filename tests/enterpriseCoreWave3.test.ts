import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OpenAIProvider } from '../src/providers/openai.js';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-w3-')));

after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

describe('Wave 3 — Paid BYOK Parity, Core Editing, Execution & Code Intel', () => {
  test('OpenAIProvider uses max_completion_tokens and omits temperature for o-series and gpt-5/gpt-6 reasoning models', async () => {
    const o3 = new OpenAIProvider({ apiKey: 'test-oai-key-1234', model: 'o3-mini' });
    const gpt5 = new OpenAIProvider({ apiKey: 'test-oai-key-1234', model: 'gpt-5.4-mini' });
    const gpt5NoReason = new OpenAIProvider({ apiKey: 'test-oai-key-1234', model: 'gpt-5.4-mini', reasoningEffort: 'none' });
    const gpt4o = new OpenAIProvider({ apiKey: 'test-oai-key-1234', model: 'gpt-4o' });

    assert.equal(o3.usesMaxCompletionTokens(), true);
    assert.equal(o3.rejectsSamplingParameters(), true);
    assert.equal(gpt5.usesMaxCompletionTokens(), true);
    assert.equal(gpt5.rejectsSamplingParameters(), true);
    assert.equal(gpt5NoReason.usesMaxCompletionTokens(), true);
    assert.equal(gpt5NoReason.rejectsSamplingParameters(), false);
    assert.equal(gpt4o.usesMaxCompletionTokens(), false);
    assert.equal(gpt4o.rejectsSamplingParameters(), false);

    const origFetch = globalThis.fetch;
    let capturedBody: any = null;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body || '{}'));
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'ok' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 }
        })
      } as unknown as Response;
    }) as typeof fetch;

    try {
      await gpt5.chat([{ role: 'user', content: 'hi' }], { maxTokens: 1024, temperature: 0.2 });
      assert.equal(capturedBody.max_completion_tokens, 1024);
      assert.equal(capturedBody.max_tokens, undefined);
      assert.equal(capturedBody.temperature, undefined);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
