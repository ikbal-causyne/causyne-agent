import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OpenAIProvider } from '../src/providers/openai.js';
import { AnthropicProvider } from '../src/providers/anthropic.js';

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

  test('AnthropicProvider restricts tool search to Claude 4.5+/5, defaults to 5m cache, adds rolling history breakpoint, merges assistant turns, and preserves thinking_blocks', async () => {
    const claude35 = new AnthropicProvider({ apiKey: 'ant-test-key-1234', model: 'claude-3-5-sonnet' });
    const claude46 = new AnthropicProvider({ apiKey: 'ant-test-key-1234', model: 'claude-sonnet-4-6' });
    assert.equal(claude35.supportsToolSearch(), false);
    assert.equal(claude46.supportsToolSearch(), true);
    assert.equal(claude46.cacheTtl, '5m');

    const origFetch = globalThis.fetch;
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: any = null;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = (init?.headers as Record<string, string>) || {};
      capturedBody = JSON.parse(String(init?.body || '{}'));
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify({
          content: [{ type: 'text', text: 'ok' }],
          usage: { input_tokens: 100, output_tokens: 20 }
        })
      } as unknown as Response;
    }) as typeof fetch;

    try {
      const res = await claude46.chat([
        { role: 'system', content: 'sys', cacheAnchor: true },
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'step 1', thinking_blocks: [{ type: 'thinking', thinking: 'hmm', signature: 'sig1' }] },
        { role: 'assistant', content: 'step 2' },
        { role: 'user', content: 'second' }
      ], { tools: [{ name: 'fs_read', description: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }] });

      assert.equal(capturedHeaders['anthropic-beta'], 'advanced-tool-use-2025-11-20');
      assert.equal(capturedBody.messages.length, 3, 'consecutive assistant messages must merge');
      const assistantBlocks = capturedBody.messages[1].content;
      assert.equal(assistantBlocks[0]?.type, 'thinking', 'thinking_blocks must survive on text-only assistant turn');
      assert.equal(assistantBlocks[2]?.text, 'step 2');
      assert.equal(capturedBody.messages[2].content[0]?.cache_control?.type, 'ephemeral', 'rolling user history cache breakpoint must be set');
      assert.equal(capturedBody.messages[2].content[0]?.cache_control?.ttl, undefined, 'default 5m cache omits 1h ttl');
      assert.equal(res.usage.measurement, 'provider_reported');
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
