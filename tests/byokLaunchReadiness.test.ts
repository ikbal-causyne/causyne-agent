import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MODEL_CATALOGUE,
  DEFAULT_MODEL_BY_PROVIDER,
  UTILITY_MODEL_BY_PROVIDER
} from '../src/modelCatalogue.js';
import { createProvider } from '../src/providers/factory.js';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import { OpenAIProvider } from '../src/providers/openai.js';
import { OpenAICompatibleProvider, isMistralEndpoint } from '../src/providers/openai-compatible.js';
import { QwenByokProvider } from '../src/providers/qwen-byok.js';
import { DashscopeByokProvider } from '../src/providers/dashscope-byok.js';
import { MoonshotProvider } from '../src/providers/moonshot.js';
import { DeepSeekProvider } from '../src/providers/deepseek.js';
import { XAIProvider } from '../src/providers/xai.js';
import {
  normalizeMessagesForMistral,
  toMistralToolCallId
} from '../src/providers/wireNormalizer.js';
import {
  clearProviderDiagnostics,
  formatRedactedProviderErrorReport,
  getRecentProviderDiagnostics,
  safeProviderFetchJson
} from '../src/providers/byokHttp.js';
import {
  adaptSchemaForGemini,
  scanAndAdaptToolsForProvider
} from '../src/tools/toolScanner.js';
import { TOOL_DEFINITIONS } from '../src/tools/registry.js';
import { runCommand } from '../src/commands.js';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  });
}

describe('BYOK Pre-Launch Protocol Hardening & Strict Schema Verification', () => {
  test('modelCatalogue publishes verified live defaults and removes retired Gemini 1.5 slugs', () => {
    assert.equal(DEFAULT_MODEL_BY_PROVIDER.deepseek, 'deepseek-flash');
    assert.equal(UTILITY_MODEL_BY_PROVIDER.deepseek, 'deepseek-flash');
    assert.equal(DEFAULT_MODEL_BY_PROVIDER.anthropic, 'claude-sonnet-5-5');
    assert.equal(UTILITY_MODEL_BY_PROVIDER.anthropic, 'claude-haiku-5-5');
    assert.equal(DEFAULT_MODEL_BY_PROVIDER.moonshot, 'k3.1-pro');
    assert.equal(DEFAULT_MODEL_BY_PROVIDER.gemini, 'gemini-2.5-pro');
    assert.equal(DEFAULT_MODEL_BY_PROVIDER['gemini-free'], 'gemini-2.5-flash');

    const geminiList = MODEL_CATALOGUE['Gemini'] ?? [];
    assert.ok(!geminiList.includes('gemini-1.5-pro'), 'retired gemini-1.5-pro must not be listed');
    assert.ok(!geminiList.includes('gemini-1.5-flash'), 'retired gemini-1.5-flash must not be listed');
    assert.ok(geminiList.includes('gemini-4-argon'));
    assert.ok(geminiList.includes('gemini-3.8-flash'));

    assert.equal(new DeepSeekProvider({ apiKey: 'k', model: 'deepseek-flash' }).supportsVision, true);
    assert.equal(new DeepSeekProvider({ apiKey: 'k', model: 'deepseek-chat' }).supportsVision, false);
    assert.equal(new MoonshotProvider({ apiKey: 'k', model: 'k3.1-pro' }).supportsVision, true);
  });

  test('OpenAICompatibleProvider guards reasoning_effort on Mistral/non-reasoning models and retries on 400 rejection', async () => {
    assert.equal(isMistralEndpoint('https://api.mistral.ai/v1/chat/completions'), true);
    assert.equal(isMistralEndpoint('https://api.groq.com/openai/v1/chat/completions'), false);

    const origFetch = globalThis.fetch;
    const seenPayloads: Array<Record<string, any>> = [];
    try {
      globalThis.fetch = (async (_url: any, init: any) => {
        const parsed = JSON.parse(String(init?.body || '{}'));
        seenPayloads.push(parsed);
        // Simulate an upstream OpenAI-compatible gateway rejecting reasoning_effort on a custom reasoning model
        if (parsed.model === 'custom-qwen3-proxy' && 'reasoning_effort' in parsed) {
          return jsonResponse({ error: { message: 'Unrecognized request argument: reasoning_effort' } }, 400);
        }
        return jsonResponse({
          choices: [{ message: { role: 'assistant', content: 'ok' } }],
          usage: { prompt_tokens: 10, completion_tokens: 2 }
        });
      }) as typeof fetch;

      // 1. Mistral never receives reasoning_effort even if configured globally
      const mistral = createProvider({
        provider: 'mistral',
        apiKey: 'test-mistral-key',
        model: 'devstral-small-latest',
        reasoningEffort: 'high'
      });
      await mistral.chat([{ role: 'user', content: 'hi' }]);
      assert.equal('reasoning_effort' in seenPayloads[0]!, false);

      // 2. Non-reasoning Groq model never receives reasoning_effort
      const groqLlama = createProvider({
        provider: 'groq',
        apiKey: 'test-groq-key',
        model: 'llama-3.3-70b-versatile',
        reasoningEffort: 'medium'
      });
      await groqLlama.chat([{ role: 'user', content: 'hi' }]);
      assert.equal('reasoning_effort' in seenPayloads[1]!, false);

      // 3. OpenAI gpt-4o skips reasoning_effort, while o3-mini includes it
      const gpt4o = new OpenAIProvider({ apiKey: 'test-oai', model: 'gpt-4o', reasoningEffort: 'high' });
      await gpt4o.chat([{ role: 'user', content: 'hi' }]);
      assert.equal('reasoning_effort' in seenPayloads[2]!, false);

      const o3mini = new OpenAIProvider({ apiKey: 'test-oai', model: 'o3-mini', reasoningEffort: 'high' });
      await o3mini.chat([{ role: 'user', content: 'hi' }]);
      assert.equal(seenPayloads[3]!.reasoning_effort, 'high');

      // 4. Custom reasoning model that gets HTTP 400 on reasoning_effort transparently strips & retries once
      const customReasoning = new OpenAICompatibleProvider({
        apiKey: 'test-custom',
        baseUrl: 'https://proxy.example.com/v1/chat/completions',
        model: 'custom-qwen3-proxy',
        reasoningEffort: 'high'
      });
      const res = await customReasoning.chat([{ role: 'user', content: 'hi' }]);
      assert.equal(res.content, 'ok');
      assert.equal(seenPayloads[4]!.reasoning_effort, 'high');
      assert.equal('reasoning_effort' in seenPayloads[5]!, false);

      // 5. xAI grok-420-reasoning sends reasoning_effort cleanly while grok-4.7 omits it
      const grokReason = new XAIProvider({ apiKey: 'test-xai', model: 'grok-420-reasoning', reasoningEffort: 'xhigh' });
      await grokReason.chat([{ role: 'user', content: 'hi' }]);
      assert.equal(seenPayloads[6]!.reasoning_effort, 'xhigh');

      const grokStd = new XAIProvider({ apiKey: 'test-xai', model: 'grok-4.7', reasoningEffort: 'xhigh' });
      await grokStd.chat([{ role: 'user', content: 'hi' }]);
      assert.equal('reasoning_effort' in seenPayloads[7]!, false);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test('Mistral normalizes cross-provider tool call IDs deterministically to strict 9-char [a-zA-Z0-9]{9}', async () => {
    const MISTRAL_RE = /^[a-zA-Z0-9]{9}$/;
    assert.equal(toMistralToolCallId('Abc123XyZ'), 'Abc123XyZ');
    assert.match(toMistralToolCallId('call_oai_1732500000_0_1'), MISTRAL_RE);
    assert.equal(
      toMistralToolCallId('toolu_01ABCXYZ_long_id'),
      toMistralToolCallId('toolu_01ABCXYZ_long_id')
    );

    const history = [
      { role: 'user', content: 'inspect file' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call_oai_1732500000_0_1', type: 'function', function: { name: 'fs_read', arguments: '{"path":"a.ts"}' } },
          { id: 'ValidId09', type: 'function', function: { name: 'fs_read', arguments: '{"path":"b.ts"}' } }
        ]
      },
      { role: 'tool', tool_call_id: 'call_oai_1732500000_0_1', name: 'fs_read', content: 'contents A' },
      { role: 'tool', tool_call_id: 'ValidId09', name: 'fs_read', content: 'contents B' }
    ];

    const normalized = normalizeMessagesForMistral(history);
    const tc0 = normalized[1].tool_calls[0].id;
    const tc1 = normalized[1].tool_calls[1].id;
    assert.match(tc0, MISTRAL_RE);
    assert.equal(tc1, 'ValidId09');
    assert.equal(normalized[2].tool_call_id, tc0, 'tool response must keep exact mapped ID');
    assert.equal(normalized[3].tool_call_id, 'ValidId09');

    // End-to-end check through Mistral provider wire request and response
    const origFetch = globalThis.fetch;
    let sentBody: Record<string, any> | null = null;
    try {
      globalThis.fetch = (async (_url: any, init: any) => {
        sentBody = JSON.parse(String(init?.body || '{}'));
        return jsonResponse({
          choices: [{
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{ id: 'bad_id_with_underscores', type: 'function', function: { name: 'fs_read', arguments: '{"path":"c.ts"}' } }]
            }
          }],
          usage: { prompt_tokens: 20, completion_tokens: 5 }
        });
      }) as typeof fetch;

      const mistral = createProvider({
        provider: 'mistral',
        apiKey: 'test-mistral-key',
        model: 'devstral-small-latest'
      });
      const out = await mistral.chat(history);
      assert.ok(sentBody);
      assert.match((sentBody as any).messages[1].tool_calls[0].id, MISTRAL_RE);
      assert.equal((sentBody as any).messages[2].tool_call_id, (sentBody as any).messages[1].tool_calls[0].id);
      assert.ok(out.toolCalls && out.toolCalls.length === 1);
      assert.match(out.toolCalls[0]!.id, MISTRAL_RE);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test('Qwen/DashScope and Moonshot provide explicit regional endpoint guidance on HTTP 401', async () => {
    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => jsonResponse({ error: { message: 'InvalidApiKey' } }, 401)) as typeof fetch;

      const qwenIntl = new QwenByokProvider({ apiKey: 'test-qwen-cn-key', model: 'qwen-plus' });
      await assert.rejects(
        () => qwenIntl.chat([{ role: 'user', content: 'hi' }]),
        /dashscope\.aliyuncs\.com\/compatible-mode\/v1\/chat\/completions/
      );

      const dashscopeCn = new DashscopeByokProvider({
        apiKey: 'test-dashscope-intl-key',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',
        model: 'qwen-plus'
      });
      await assert.rejects(
        () => dashscopeCn.chat([{ role: 'user', content: 'hi' }]),
        /dashscope-intl\.aliyuncs\.com\/compatible-mode\/v1\/chat\/completions/
      );

      const moonshotGlobal = new MoonshotProvider({ apiKey: 'test-kimi-cn-key', model: 'k3.1-pro' });
      await assert.rejects(
        () => moonshotGlobal.chat([{ role: 'user', content: 'hi' }]),
        /api\.moonshot\.cn\/v1\/chat\/completions/
      );
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test('AnthropicProvider gracefully falls back on HTTP 400 when beta tool_search or adaptive thinking is unsupported', async () => {
    const origFetch = globalThis.fetch;
    const calls: Array<{ headers: Record<string, string>; body: Record<string, any> }> = [];
    try {
      globalThis.fetch = (async (_url: any, init: any) => {
        const headers = (init?.headers || {}) as Record<string, string>;
        const body = JSON.parse(String(init?.body || '{}'));
        calls.push({ headers, body });
        if (calls.length === 1) {
          return jsonResponse(
            { type: 'error', error: { type: 'invalid_request_error', message: 'tool_search_tool_regex_20251119 is not supported on this gateway' } },
            400
          );
        }
        return jsonResponse({
          content: [{ type: 'text', text: 'fallback_succeeded' }],
          usage: { input_tokens: 15, output_tokens: 4 }
        });
      }) as typeof fetch;

      const anthropic = new AnthropicProvider({
        apiKey: 'test-anthropic-key',
        model: 'claude-sonnet-5-5',
        reasoningEffort: 'medium'
      });
      const res = await anthropic.chat([{ role: 'user', content: 'hello' }], {
        tools: [{
          name: 'fs_read',
          description: 'Read a file',
          parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
        }]
      });

      assert.equal(res.content, 'fallback_succeeded');
      assert.equal(calls.length, 2);
      assert.equal(calls[0]!.headers['anthropic-beta'], 'advanced-tool-use-2025-11-20');
      assert.ok(calls[0]!.body.thinking);
      assert.equal('anthropic-beta' in calls[1]!.headers, false);
      assert.equal('thinking' in calls[1]!.body, false);
      assert.equal('output_config' in calls[1]!.body, false);
      assert.equal(calls[1]!.body.tools[0].name, 'fs_read');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test('Every registered Causyne tool compiles cleanly for strict Gemini v1beta schema validation (including format filtering)', () => {
    const formatCheck = adaptSchemaForGemini({
      type: 'object',
      properties: {
        homepage: { type: 'string', format: 'uri', description: 'URL' },
        createdAt: { type: 'string', format: 'date-time', description: 'Timestamp' },
        count: { type: 'integer', format: 'int32', description: 'Count' },
        email: { type: 'string', format: 'email' }
      }
    }) as Record<string, any>;
    assert.equal(formatCheck.properties.homepage.format, undefined);
    assert.match(formatCheck.properties.homepage.description, /uri/i);
    assert.equal(formatCheck.properties.createdAt.format, 'date-time');
    assert.equal(formatCheck.properties.count.format, 'int32');
    assert.equal(formatCheck.properties.email.format, undefined);

    const report = scanAndAdaptToolsForProvider(TOOL_DEFINITIONS as any[], 'gemini');
    assert.ok(report.totalTools >= 60, `Expected >= 60 registered tools, got ${report.totalTools}`);
    assert.equal(
      report.residualIssues.length,
      0,
      `Residual Gemini schema issues found: ${JSON.stringify(report.residualIssues.slice(0, 5))}`
    );
    assert.equal(report.universalReady, true);
  });

  test('byokHttp records secret-redacted HTTP error diagnostics surfaced by /doctor --report', async () => {
    clearProviderDiagnostics();
    const fakeSecret = 'TEST_FAKE_SECRET_TOKEN_XYZ_999';
    const origFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => jsonResponse(
        { error: { message: `Invalid key ${fakeSecret} on request` } },
        400
      )) as typeof fetch;

      await assert.rejects(
        () => safeProviderFetchJson({
          url: 'https://api.example.com/v1/chat/completions',
          providerLabel: 'TestProvider',
          headers: { Authorization: `Bearer ${fakeSecret}` },
          secrets: [fakeSecret],
          hasApiKey: true,
          body: '{}'
        }),
        /TestProvider API Error \(400\)/
      );

      const recorded = getRecentProviderDiagnostics();
      assert.equal(recorded.length, 1);
      assert.equal(recorded[0]!.status, 400);
      assert.equal(recorded[0]!.endpointHostPath, 'https://api.example.com/v1/chat/completions');
      assert.ok(!recorded[0]!.errorPreview.includes(fakeSecret));

      const formatted = formatRedactedProviderErrorReport({ provider: 'openai', model: 'gpt-4o' });
      assert.match(formatted, /Causyne Redacted Provider HTTP Error Report/);
      assert.match(formatted, /TestProvider — HTTP 400/);
      assert.ok(!formatted.includes(fakeSecret));

      const cmdRes = await runCommand('doctor', ['--report'], { surface: 'terminal' });
      assert.equal(cmdRes.ok, true);
      assert.match(cmdRes.output, /Causyne Redacted Provider HTTP Error Report/);
      assert.ok(!cmdRes.output.includes(fakeSecret));
    } finally {
      clearProviderDiagnostics();
      globalThis.fetch = origFetch;
    }
  });
});
