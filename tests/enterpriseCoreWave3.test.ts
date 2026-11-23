import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OpenAIProvider } from '../src/providers/openai.js';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import { GeminiProvider } from '../src/providers/gemini.js';
import { DeepSeekProvider } from '../src/providers/deepseek.js';
import { OpenAICompatibleProvider } from '../src/providers/openai-compatible.js';
import { applyPatch } from '../src/tools/applyPatch.js';

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

  test('Gemini merges same-role turns & deduplicates JSON-fallback thought text; DeepSeek backfills reasoner reasoning_content; OpenAICompatible normalizes bare local root URLs', async () => {
    const localCompat = new OpenAICompatibleProvider({ baseUrl: 'http://127.0.0.1:1234', model: 'qwen-local' });
    assert.equal(localCompat.baseUrl, 'http://127.0.0.1:1234/v1/chat/completions');

    const origFetch = globalThis.fetch;
    let geminiBody: any = null;
    let deepseekBody: any = null;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body || '{}'));
      if (url.includes('generativelanguage.googleapis.com')) {
        geminiBody = body;
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => JSON.stringify({
            candidates: [{
              content: {
                role: 'model',
                parts: [
                  { thought: true, text: 'Single thought.' },
                  { text: 'Final answer.' }
                ]
              }
            }],
            usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 8, totalTokenCount: 20 }
          })
        } as unknown as Response;
      }
      deepseekBody = body;
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'done' } }],
          usage: { prompt_tokens: 15, completion_tokens: 5 }
        })
      } as unknown as Response;
    }) as typeof fetch;

    try {
      const gemini = new GeminiProvider({ apiKey: 'gem-test-key-1234', model: 'gemini-2.5-flash' });
      const gemRes = await gemini.chat([
        { role: 'user', content: 'part 1' },
        { role: 'user', content: 'part 2' },
        { role: 'assistant', content: 'reply 1' },
        { role: 'assistant', content: 'reply 2' },
        { role: 'user', content: 'final question' }
      ], { onChunk: () => {} });
      assert.equal(geminiBody.contents.length, 3, 'consecutive same-role Gemini contents must merge');
      assert.equal(geminiBody.contents[0].parts.length, 2);
      assert.equal(geminiBody.contents[1].parts.length, 2);
      assert.equal(gemRes.reasoningContent, 'Single thought.', 'JSON-fallback thought must not double-append');

      const ds = new DeepSeekProvider({ apiKey: 'ds-test-key-1234', model: 'deepseek-reasoner' });
      await ds.chat([
        { role: 'user', content: 'run tool' },
        { role: 'assistant', content: '', tool_calls: [{ id: 'tc1', type: 'function', function: { name: 'fs_read', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'tc1', content: 'ok' }
      ]);
      assert.equal(deepseekBody.messages[1].reasoning_content, '', 'deepseek-reasoner must backfill missing reasoning_content on historical tool turns');
      assert.equal(deepseekBody.temperature, undefined);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test('applyPatch preserves CRLF line endings and safely executes case-only renames without data loss', async () => {
    const ws = path.join(TMP, 'patch-crlf-case');
    fs.mkdirSync(ws, { recursive: true });
    const crlfFile = path.join(ws, 'WinFile.ts');
    fs.writeFileSync(crlfFile, 'export const a = 1;\r\nexport const b = 2;\r\n', 'utf8');

    const res = await applyPatch.execute({
      patch: [
        '*** Begin Patch',
        '*** Update File: WinFile.ts',
        '*** Move to: winfile.ts',
        '@@',
        ' export const a = 1;',
        '-export const b = 2;',
        '+export const b = 42;',
        '*** End Patch'
      ].join('\n')
    }, { workspaceRoot: ws });

    assert.equal(res.success, true, res.error);
    const entries = fs.readdirSync(ws);
    assert.ok(entries.includes('winfile.ts'), `expected case-only rename target winfile.ts in [${entries.join(', ')}]`);
    const content = fs.readFileSync(path.join(ws, 'winfile.ts'), 'utf8');
    assert.equal(content, 'export const a = 1;\r\nexport const b = 42;\r\n', 'CRLF line endings must be preserved');
  });

  test('applyPatch honors @@ contextHeader, *** End of File, rejects ambiguous hunks, emits closest-line hints, and allows Delete+Add replacement', async () => {
    const ws = path.join(TMP, 'patch-anchors');
    fs.mkdirSync(ws, { recursive: true });
    const dupFile = path.join(ws, 'dups.ts');
    fs.writeFileSync(dupFile, [
      'function alpha() {',
      '  return 1;',
      '}',
      'function beta() {',
      '  return 1;',
      '}',
      ''
    ].join('\n'), 'utf8');

    // Ambiguous hunk without @@ context header must fail atomically
    const ambig = await applyPatch.execute({
      patch: [
        '*** Begin Patch',
        '*** Update File: dups.ts',
        '@@',
        '-  return 1;',
        '+  return 2;',
        '*** End Patch'
      ].join('\n')
    }, { workspaceRoot: ws });
    assert.equal(ambig.success, false);
    assert.match(ambig.error || '', /ambiguous/i);

    // Disambiguated with @@ function beta() patches ONLY beta()
    const disambig = await applyPatch.execute({
      patch: [
        '*** Begin Patch',
        '*** Update File: dups.ts',
        '@@ function beta()',
        '-  return 1;',
        '+  return 99;',
        '*** End Patch'
      ].join('\n')
    }, { workspaceRoot: ws });
    assert.equal(disambig.success, true, disambig.error);
    const updated = fs.readFileSync(dupFile, 'utf8');
    assert.match(updated, /alpha\(\) \{\n  return 1;/);
    assert.match(updated, /beta\(\) \{\n  return 99;/);

    // Mismatch emits closest-line hint
    const miss = await applyPatch.execute({
      patch: [
        '*** Begin Patch',
        '*** Update File: dups.ts',
        '@@',
        '-  return 777;',
        '+  return 888;',
        '*** End Patch'
      ].join('\n')
    }, { workspaceRoot: ws });
    assert.equal(miss.success, false);
    assert.match(miss.error || '', /Closest line/i);

    // Delete + Add of same path in one patch succeeds
    const replaceRes = await applyPatch.execute({
      patch: [
        '*** Begin Patch',
        '*** Delete File: dups.ts',
        '*** Add File: dups.ts',
        '+export const replaced = true;',
        '*** End Patch'
      ].join('\n')
    }, { workspaceRoot: ws });
    assert.equal(replaceRes.success, true, replaceRes.error);
    assert.equal(fs.readFileSync(dupFile, 'utf8'), 'export const replaced = true;\n');
  });
});
