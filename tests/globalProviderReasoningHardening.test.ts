import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { clampOpenAIReasoningEffort, OpenAIProvider } from '../src/providers/openai.js';
import { OpenAICompatibleProvider } from '../src/providers/openai-compatible.js';
import { MuseProvider } from '../src/providers/muse.js';
import { OpenRouterProvider } from '../src/providers/openrouter.js';
import { XAIProvider } from '../src/providers/xai.js';
import { MoonshotProvider } from '../src/providers/moonshot.js';
import { DashscopeByokProvider } from '../src/providers/dashscope-byok.js';
import { QwenByokProvider } from '../src/providers/qwen-byok.js';
import { OllamaProvider } from '../src/providers/ollama.js';
import { runSetup } from '../src/tui/setup.js';

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  });
}

function okOpenAiBody(text = 'ok') {
  return {
    choices: [{ message: { role: 'assistant', content: text } }],
    usage: { prompt_tokens: 12, completion_tokens: 4 }
  };
}

describe('Global Cross-Provider Reasoning & Variant Hardening', () => {
  test('clampOpenAIReasoningEffort strictly enforces per-family OpenAI effort boundaries', () => {
    // o-pro models only accept medium | high
    assert.equal(clampOpenAIReasoningEffort('low', 'o3-pro'), 'medium');
    assert.equal(clampOpenAIReasoningEffort('minimal', 'o1-pro'), 'medium');
    assert.equal(clampOpenAIReasoningEffort('max', 'o3-pro'), 'high');
    assert.equal(clampOpenAIReasoningEffort('xhigh', 'o4-pro'), 'high');
    assert.equal(clampOpenAIReasoningEffort('off', 'o3-pro'), null);

    // o1 / o3 / o4-mini only accept low | medium | high
    assert.equal(clampOpenAIReasoningEffort('minimal', 'o3-mini'), 'low');
    assert.equal(clampOpenAIReasoningEffort('xhigh', 'o3-mini'), 'high');
    assert.equal(clampOpenAIReasoningEffort('max', 'o4-mini'), 'high');
    assert.equal(clampOpenAIReasoningEffort('ultra', 'o1'), 'high');
    assert.equal(clampOpenAIReasoningEffort('none', 'o3'), null);

    // GPT-5.2+ / GPT-6 / Codex accept none | low | medium | high | xhigh
    assert.equal(clampOpenAIReasoningEffort('off', 'gpt-5.4'), 'none');
    assert.equal(clampOpenAIReasoningEffort('none', 'gpt-5.4-mini'), 'none');
    assert.equal(clampOpenAIReasoningEffort('minimal', 'gpt-5.4'), 'low');
    assert.equal(clampOpenAIReasoningEffort('max', 'gpt-5.4'), 'xhigh');
    assert.equal(clampOpenAIReasoningEffort('ultra', 'gpt-6'), 'xhigh');
    assert.equal(clampOpenAIReasoningEffort('xhigh', 'gpt-5.3-codex'), 'xhigh');

    // GPT-5.0 / 5.1 accept minimal | low | medium | high
    assert.equal(clampOpenAIReasoningEffort('off', 'gpt-5'), 'minimal');
    assert.equal(clampOpenAIReasoningEffort('none', 'gpt-5.1'), 'minimal');
    assert.equal(clampOpenAIReasoningEffort('xhigh', 'gpt-5'), 'high');
    assert.equal(clampOpenAIReasoningEffort('max', 'gpt-5.1'), 'high');

    // Non-reasoning and -chat models never emit reasoning_effort
    assert.equal(clampOpenAIReasoningEffort('high', 'gpt-4o'), null);
    assert.equal(clampOpenAIReasoningEffort('xhigh', 'gpt-5.4-chat-latest'), null);
  });

  test('OpenAI, OpenAI-compatible gateways, and Muse clamp payloads and preserve Muse max tier', async () => {
    const origFetch = globalThis.fetch;
    const seen: Array<Record<string, any>> = [];
    try {
      globalThis.fetch = (async (_url: any, init: any) => {
        const body = JSON.parse(String(init?.body || '{}'));
        seen.push(body);
        if (body.model === 'proxy-qwen3-strict' && 'reasoning_effort' in body) {
          return jsonResponse({ error: { message: 'Invalid value for effort: must be one of low, medium' } }, 400);
        }
        return jsonResponse(okOpenAiBody());
      }) as typeof fetch;

      // OpenAI o3-pro clamps stale 'max' -> 'high'
      const o3Pro = new OpenAIProvider({ apiKey: 'test-oai', model: 'o3-pro', reasoningEffort: 'max' });
      await o3Pro.chat([{ role: 'user', content: 'hi' }]);
      assert.equal(seen[0]!.reasoning_effort, 'high');

      // OpenAI gpt-5.4 clamps stale 'max' -> 'xhigh'
      const gpt54 = new OpenAIProvider({ apiKey: 'test-oai', model: 'gpt-5.4', reasoningEffort: 'max' });
      await gpt54.chat([{ role: 'user', content: 'hi' }]);
      assert.equal(seen[1]!.reasoning_effort, 'xhigh');

      // Generic OpenAI-compatible gateway clamps stale 'max' -> 'high' and retries without reasoning_effort on HTTP 400
      const gateway = new OpenAICompatibleProvider({
        apiKey: 'test-gw',
        baseUrl: 'https://gateway.example.com/v1/chat/completions',
        model: 'proxy-qwen3-strict',
        reasoningEffort: 'max'
      });
      const gwRes = await gateway.chat([{ role: 'user', content: 'hi' }]);
      assert.equal(gwRes.content, 'ok');
      assert.equal(seen[2]!.reasoning_effort, 'high');
      assert.equal('reasoning_effort' in seen[3]!, false);

      // Muse standard preserves native 'max', while -contributor clamps to 'high'
      const museStd = new MuseProvider({ apiKey: 'test-muse', model: 'muse-spark-1.3', reasoningEffort: 'max' });
      await museStd.chat([{ role: 'user', content: 'hi' }]);
      assert.equal(seen[4]!.reasoning_effort, 'max');

      const museContrib = new MuseProvider({ apiKey: 'test-muse', model: 'muse-spark-1.3-contributor', reasoningEffort: 'max' });
      await museContrib.chat([{ role: 'user', content: 'hi' }]);
      assert.equal(seen[5]!.reasoning_effort, 'high');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test('OpenRouter strips rejected reasoning parameter on HTTP 400/404 and succeeds cleanly', async () => {
    const origFetch = globalThis.fetch;
    const seen: Array<Record<string, any>> = [];
    try {
      globalThis.fetch = (async (_url: any, init: any) => {
        const body = JSON.parse(String(init?.body || '{}'));
        seen.push(body);
        if ('reasoning' in body) {
          return jsonResponse({ error: { message: 'No endpoints found that can handle the requested parameters (reasoning)' } }, 404);
        }
        return jsonResponse(okOpenAiBody('openrouter-healed'));
      }) as typeof fetch;

      const orPaid = new OpenRouterProvider({
        apiKey: 'test-or-key',
        model: 'openai/gpt-4o-mini',
        freeOnly: false,
        reasoningEffort: 'max'
      });
      const res = await orPaid.chat([{ role: 'user', content: 'hi' }]);
      assert.equal(res.content, 'openrouter-healed');
      assert.equal(seen.length, 2);
      assert.deepEqual(seen[0]!.reasoning, { effort: 'high' });
      assert.equal('reasoning' in seen[1]!, false);

      // Free-tier OpenRouter also heals identically on HTTP 400/404 reasoning rejection
      const orFree = new OpenRouterProvider({
        apiKey: 'test-or-key',
        model: 'openrouter/free',
        freeOnly: true,
        reasoningEffort: 'high'
      });
      const freeRes = await orFree.chat([{ role: 'user', content: 'hi' }]);
      assert.equal(freeRes.content, 'openrouter-healed');
      assert.equal(seen.length, 4);
      assert.deepEqual(seen[2]!.reasoning, { effort: 'high' });
      assert.equal('reasoning' in seen[3]!, false);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test('xAI clamps grok-3-mini and grok-4 reasoning tiers and retries cleanly on HTTP 400 rejection', async () => {
    const origFetch = globalThis.fetch;
    const seen: Array<Record<string, any>> = [];
    try {
      globalThis.fetch = (async (_url: any, init: any) => {
        const body = JSON.parse(String(init?.body || '{}'));
        seen.push(body);
        if (body.model === 'grok-4-fast-reasoning' && 'reasoning_effort' in body) {
          return jsonResponse({ error: { message: 'Parameter reasoning_effort is not supported by this model' } }, 400);
        }
        return jsonResponse(okOpenAiBody('xai-ok'));
      }) as typeof fetch;

      // grok-3-mini clamps medium/max -> high
      const mini = new XAIProvider({ apiKey: 'test-xai', model: 'grok-3-mini', reasoningEffort: 'max' });
      await mini.chat([{ role: 'user', content: 'hi' }]);
      assert.equal(seen[0]!.reasoning_effort, 'high');

      // grok-4-fast-non-reasoning omits reasoning_effort
      const nonReason = new XAIProvider({ apiKey: 'test-xai', model: 'grok-4-fast-non-reasoning', reasoningEffort: 'high' });
      await nonReason.chat([{ role: 'user', content: 'hi' }]);
      assert.equal('reasoning_effort' in seen[1]!, false);

      // grok-4-fast-reasoning retries once without reasoning_effort on HTTP 400
      const fastReason = new XAIProvider({ apiKey: 'test-xai', model: 'grok-4-fast-reasoning', reasoningEffort: 'max' });
      const res = await fastReason.chat([{ role: 'user', content: 'hi' }]);
      assert.equal(res.content, 'xai-ok');
      assert.equal(seen[2]!.reasoning_effort, 'high');
      assert.equal('reasoning_effort' in seen[3]!, false);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test('Moonshot (.ai/.cn), DashScope (Intl), and Qwen (CN) self-heal on HTTP 400 thinking rejections', async () => {
    const origFetch = globalThis.fetch;
    const seen: Array<Record<string, any>> = [];
    try {
      globalThis.fetch = (async (_url: any, init: any) => {
        const body = JSON.parse(String(init?.body || '{}'));
        seen.push(body);
        if ('thinking' in body || 'reasoning_effort' in body) {
          return jsonResponse({ error: { message: 'thinking parameter is not supported for this endpoint' } }, 400);
        }
        if ('enable_thinking' in body || 'thinking_budget' in body) {
          return jsonResponse({ error: { message: 'Invalid parameter: enable_thinking unsupported' } }, 400);
        }
        return jsonResponse(okOpenAiBody('regional-healed'));
      }) as typeof fetch;

      // Moonshot clamps 'max' -> 'high' and falls back cleanly without thinking / reasoning_effort
      const moonshot = new MoonshotProvider({
        apiKey: 'test-ms',
        model: 'kimi-k2.5',
        reasoningEffort: 'max'
      });
      const msRes = await moonshot.chat([{ role: 'user', content: 'hi' }]);
      assert.equal(msRes.content, 'regional-healed');
      assert.equal(seen[0]!.reasoning_effort, 'high');
      assert.equal('thinking' in seen[1]!, false);
      assert.equal('reasoning_effort' in seen[1]!, false);

      // DashScope BYOK (Intl) strips enable_thinking + thinking_budget on HTTP 400
      const dash = new DashscopeByokProvider({
        apiKey: 'test-dash',
        model: 'qwen3-max',
        reasoningEffort: 'high'
      });
      const dashRes = await dash.chat([{ role: 'user', content: 'hi' }]);
      assert.equal(dashRes.content, 'regional-healed');
      assert.equal(seen[2]!.enable_thinking, true);
      assert.equal('enable_thinking' in seen[3]!, false);
      assert.equal('thinking_budget' in seen[3]!, false);

      // Qwen BYOK strips enable_thinking + thinking_budget on HTTP 400
      const qwen = new QwenByokProvider({
        apiKey: 'test-qwen',
        model: 'qwen3-max',
        reasoningEffort: 'high'
      });
      const qwenRes = await qwen.chat([{ role: 'user', content: 'hi' }]);
      assert.equal(qwenRes.content, 'regional-healed');
      assert.equal(seen[4]!.enable_thinking, true);
      assert.equal('enable_thinking' in seen[5]!, false);
      assert.equal('thinking_budget' in seen[5]!, false);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test('Ollama clamps gpt-oss stale effort and self-heals when local model rejects think parameter', async () => {
    const origFetch = globalThis.fetch;
    const chatPayloads: Array<Record<string, any>> = [];
    const uniqueHost = 'http://127.0.0.1:19434';
    try {
      globalThis.fetch = (async (url: any, init: any) => {
        const urlStr = String(url);
        if (urlStr.endsWith('/api/show')) {
          return jsonResponse({ capabilities: ['completion', 'thinking'] });
        }
        const body = JSON.parse(String(init?.body || '{}'));
        chatPayloads.push(body);
        if ('think' in body && body.model === 'qwen3:8b-no-think-build') {
          return jsonResponse({ error: '"qwen3:8b-no-think-build" does not support thinking' }, 400);
        }
        return jsonResponse({
          message: { role: 'assistant', content: 'ollama-ok' },
          prompt_eval_count: 10,
          eval_count: 5
        });
      }) as typeof fetch;

      // 1. gpt-oss clamps stale 'max' -> 'high'
      const gptOss = new OllamaProvider({
        baseUrl: uniqueHost,
        model: 'gpt-oss:20b',
        reasoningEffort: 'max'
      });
      await gptOss.chat([{ role: 'user', content: 'hi' }]);
      assert.equal(chatPayloads[0]!.think, 'high');

      // 2. Local model rejecting think retries without think AND caches supportsThinking=false
      const localQwen = new OllamaProvider({
        baseUrl: uniqueHost,
        model: 'qwen3:8b-no-think-build',
        reasoningEffort: 'high'
      });
      const res1 = await localQwen.chat([{ role: 'user', content: 'first' }]);
      assert.equal(res1.content, 'ollama-ok');
      assert.equal(chatPayloads[1]!.think, true);
      assert.equal('think' in chatPayloads[2]!, false);

      // Next call immediately omits think thanks to cached supportsThinking=false
      const res2 = await localQwen.chat([{ role: 'user', content: 'second' }]);
      assert.equal(res2.content, 'ollama-ok');
      assert.equal('think' in chatPayloads[3]!, false);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test('runSetup clears stale reasoningEffort and reasoningBudgetTokens when switching provider or model', async () => {
    let stored: Record<string, any> = {
      provider: 'acp/opencode',
      model: 'opencode/deepseek-v4.1-flash-free',
      reasoningEffort: 'max',
      reasoningBudgetTokens: 16000
    };
    const choices = ['openai', 'workspace-write', 'save'];
    const texts = ['gpt-4o', 'sk-test-new-key'];
    const saved = await runSetup(
      {
        async select(q) {
          const id = choices.shift();
          return q.items.find((i) => i.id === id) || null;
        },
        async text() {
          return texts.shift() ?? null;
        }
      },
      [
        { id: 'openai', label: 'OpenAI', hint: '', model: 'gpt-5.4' }
      ],
      {
        loadConfig: () => ({ ...stored }),
        saveConfig: (cfg) => { stored = { ...cfg }; }
      },
      '/tmp/workspace'
    );
    assert.ok(saved);
    assert.equal(saved.provider, 'openai');
    assert.equal(saved.model, 'gpt-4o');
    assert.equal(saved.reasoningEffort, undefined);
    assert.equal(saved.reasoningBudgetTokens, undefined);
  });
});
