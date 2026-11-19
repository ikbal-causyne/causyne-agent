import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateProviderEndpointUrl,
  redactProviderSecrets,
  parseRetryAfterMs,
  resolveTemperature,
  safeProviderFetchJson,
  ProviderHttpError
} from '../src/providers/byokHttp.js';
import { GeminiProvider } from '../src/providers/gemini.js';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import { OpenAIProvider } from '../src/providers/openai.js';
import { OpenAICompatibleProvider } from '../src/providers/openai-compatible.js';
import { DeepSeekProvider } from '../src/providers/deepseek.js';
import { XAIProvider } from '../src/providers/xai.js';
import { MoonshotProvider } from '../src/providers/moonshot.js';
import { QwenByokProvider } from '../src/providers/qwen-byok.js';
import { DashscopeByokProvider } from '../src/providers/dashscope-byok.js';
import { OllamaProvider } from '../src/providers/ollama.js';
import { OpenRouterProvider, OpenRouterRateLimitError } from '../src/providers/openrouter.js';
import { fetchLiveModels } from '../src/dynamicCatalogue.js';

function withMockFetch<T>(
  mock: typeof globalThis.fetch,
  fn: () => Promise<T>
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

describe('Sector 1A — BYOK HTTP security primitives (byokHttp)', () => {
  it('blocks unsafe schemes, embedded credentials, and remote cleartext HTTP with API keys', () => {
    assert.throws(
      () => validateProviderEndpointUrl('file:///etc/passwd', { providerLabel: 'Test' }),
      /must use https:\/\/ or http:\/\//
    );
    const credUrl = new URL('https://api.example.com/v1/chat/completions');
    credUrl.username = 'demo';
    credUrl.password = 'fixture';
    assert.throws(
      () => validateProviderEndpointUrl(credUrl.toString(), { providerLabel: 'Test' }),
      /must not embed credentials/
    );
    assert.throws(
      () => validateProviderEndpointUrl('http://api.example.com/v1/chat/completions', {
        hasApiKey: true,
        providerLabel: 'Test'
      }),
      /unencrypted remote HTTP/
    );

    // Loopback HTTP (local Ollama, LM Studio, vLLM) and explicit opt-in remain allowed
    assert.equal(
      validateProviderEndpointUrl('http://127.0.0.1:11434/api/chat', { hasApiKey: true }),
      'http://127.0.0.1:11434/api/chat'
    );
    assert.equal(
      validateProviderEndpointUrl('http://localhost:8000/v1/chat/completions', { hasApiKey: false }),
      'http://localhost:8000/v1/chat/completions'
    );
    assert.equal(
      validateProviderEndpointUrl('http://192.168.1.20:8000/v1/chat/completions', {
        hasApiKey: true,
        allowInsecureHttp: true
      }),
      'http://192.168.1.20:8000/v1/chat/completions'
    );
  });

  it('redacts echoed API keys, Bearer tokens, query keys, and strips ANSI control escapes', () => {
    const secret = ['sk', 'proj', 'fixtureSecretKey987654321'].join('-');
    const queryKey = ['AIza', 'SyFixtureKeyValue1234567890'].join('');
    const raw = `\x1b[2J\x1b[31mInvalid key ${secret} with Bearer tok_abcdef123456 at ?key=${queryKey}\x1b[0m`;
    const redacted = redactProviderSecrets(raw, [secret]);

    assert.ok(!redacted.includes(secret), 'exact secret must be redacted');
    assert.ok(!redacted.includes('tok_abcdef123456'), 'Bearer token must be redacted');
    assert.ok(!redacted.includes(queryKey), 'query key must be redacted');
    assert.ok(!redacted.includes('\x1b'), 'ANSI escape sequences must be stripped');
    assert.ok(redacted.includes('[REDACTED]'));
  });

  it('parses Retry-After headers (seconds and HTTP-date) and preserves explicit temperature 0', () => {
    assert.equal(parseRetryAfterMs('12'), 12_000);
    assert.equal(parseRetryAfterMs('9999'), 300_000);
    assert.equal(parseRetryAfterMs(''), undefined);
    const future = new Date(Date.now() + 10_000).toUTCString();
    const parsedFuture = parseRetryAfterMs(future);
    assert.ok(typeof parsedFuture === 'number' && parsedFuture >= 5_000 && parsedFuture <= 15_000);

    assert.equal(resolveTemperature(0, 0.1), 0);
    assert.equal(resolveTemperature(undefined, 0.1), 0.1);
    assert.equal(resolveTemperature(Number.NaN, 0.1), 0.1);
  });

  it('enforces bounded response sizes, non-JSON diagnostics, and timeouts', async () => {
    // Oversized stream
    await withMockFetch((async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(1024).fill(65));
          controller.enqueue(new Uint8Array(1024).fill(66));
          controller.close();
        }
      });
      return new Response(stream, { status: 200 });
    }) as typeof globalThis.fetch, async () => {
      await assert.rejects(
        () => safeProviderFetchJson({
          url: 'https://api.example.com/v1/chat/completions',
          providerLabel: 'Test',
          maxBytes: 512
        }),
        /exceeded maximum allowed size/
      );
    });

    // HTML 200 OK gateway page instead of raw SyntaxError
    await withMockFetch((async () => new Response('<html><body>502 Bad Gateway</body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' }
    })) as typeof globalThis.fetch, async () => {
      await assert.rejects(
        () => safeProviderFetchJson({
          url: 'https://api.example.com/v1/chat/completions',
          providerLabel: 'Test'
        }),
        /returned a non-JSON response \(HTTP 200\)/
      );
    });

    // Timeout produces ETIMEDOUT
    await withMockFetch((async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')));
    })) as typeof globalThis.fetch, async () => {
      await assert.rejects(
        () => safeProviderFetchJson({
          url: 'https://api.example.com/v1/chat/completions',
          providerLabel: 'Test',
          timeoutMs: 1_000
        }),
        (err: any) => err?.code === 'ETIMEDOUT' && /timed out/i.test(err.message)
      );
    });
  });
});

describe('Sector 1A — BYOK provider hardening across all dialects', () => {
  it('GeminiProvider and dynamicCatalogue send API key in x-goog-api-key header, never in URL (CWE-598)', async () => {
    const secretKey = ['AIza', 'SyHardenedFixture9876543210'].join('');
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;

    await withMockFetch((async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(JSON.stringify({
        candidates: [{ content: { parts: [{ text: 'ok' }] } }],
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 }
      }), { status: 200 });
    }) as typeof globalThis.fetch, async () => {
      const gemini = new GeminiProvider({ apiKey: secretKey, model: 'gemini-2.5-pro?inject=1' });
      assert.ok(!gemini.baseUrl.includes(secretKey), 'baseUrl must never contain API key');
      assert.ok(!gemini.baseUrl.includes('?key='), 'baseUrl must never use query-string key');
      assert.ok(gemini.baseUrl.includes(encodeURIComponent('gemini-2.5-pro?inject=1')), 'model must be URL-encoded');

      const res = await gemini.chat([{ role: 'user', content: 'hi' }], { temperature: 0 });
      assert.equal(res.content, 'ok');
      assert.ok(!capturedUrl.includes(secretKey), 'fetched URL must never include API key');
      assert.equal((capturedInit?.headers as Record<string, string>)['x-goog-api-key'], secretKey);
      assert.equal(capturedInit?.redirect, 'error');
      const sentBody = JSON.parse(String(capturedInit?.body));
      assert.equal(sentBody.generationConfig.temperature, 0, 'explicit temperature 0 must be preserved');
    });

    // dynamicCatalogue Gemini model discovery also uses x-goog-api-key header + redirect: error
    await withMockFetch((async (url, init) => {
      capturedUrl = String(url);
      capturedInit = init;
      return new Response(JSON.stringify({
        models: [{ name: 'models/gemini-2.5-pro', supportedGenerationMethods: ['generateContent'] }]
      }), { status: 200 });
    }) as typeof globalThis.fetch, async () => {
      const models = await fetchLiveModels('gemini', { apiKey: secretKey });
      assert.deepEqual(models, ['gemini-2.5-pro']);
      assert.ok(!capturedUrl.includes(secretKey), 'discovery URL must never expose Gemini API key');
      assert.ok(!capturedUrl.includes('?key='));
      assert.equal((capturedInit?.headers as Record<string, string>)['x-goog-api-key'], secretKey);
      assert.equal(capturedInit?.redirect, 'error');
    });
  });

  it('all BYOK providers propagate AbortSignal, enforce redirect:error, redact leaked keys, and preserve temperature:0', async () => {
    const secretKey = ['sk', 'fixture', 'redaction998877665544'].join('-');
    const providers = [
      { name: 'anthropic', instance: new AnthropicProvider({ apiKey: secretKey, model: 'claude-3-5-sonnet' }) },
      { name: 'openai', instance: new OpenAIProvider({ apiKey: secretKey, model: 'gpt-4o' }) },
      { name: 'openai-compatible', instance: new OpenAICompatibleProvider({ apiKey: secretKey, model: 'llama-3.3' }) },
      { name: 'deepseek', instance: new DeepSeekProvider({ apiKey: secretKey, model: 'deepseek-chat' }) },
      { name: 'xai', instance: new XAIProvider({ apiKey: secretKey, model: 'grok-3' }) },
      { name: 'moonshot', instance: new MoonshotProvider({ apiKey: secretKey, model: 'kimi-k2.5' }) },
      { name: 'qwen', instance: new QwenByokProvider({ apiKey: secretKey, model: 'qwen3.7-plus' }) },
      { name: 'dashscope', instance: new DashscopeByokProvider({ apiKey: secretKey, model: 'qwen3-coder-custom' }) },
      { name: 'ollama', instance: new OllamaProvider({ model: 'llama3' }) },
      { name: 'openrouter', instance: new OpenRouterProvider({ apiKey: secretKey, model: 'openrouter/free' }) }
    ];

    for (const { name, instance } of providers) {
      // 1. Pre-aborted AbortSignal cancels immediately
      const ac = new AbortController();
      ac.abort(new DOMException('User pressed Esc', 'AbortError'));
      let capturedInit: RequestInit | undefined;
      await withMockFetch((async (_url, init) => {
        capturedInit = init;
        if (init?.signal?.aborted) throw init.signal.reason;
        throw new Error('should have been aborted');
      }) as typeof globalThis.fetch, async () => {
        await assert.rejects(() => instance.chat([{ role: 'user', content: 'ping' }], { signal: ac.signal }));
        assert.equal(capturedInit?.redirect, 'error', `${name} must enforce redirect: error`);
        assert.equal(capturedInit?.signal?.aborted, true, `${name} must propagate AbortSignal`);
      });

      // 2. HTTP 429 error redacts API key and preserves Retry-After
      await withMockFetch((async (_url, init) => {
        capturedInit = init;
        return new Response(`Rate limited for key ${secretKey} \x1b[31mboom\x1b[0m`, {
          status: 429,
          headers: { 'retry-after': '7' }
        });
      }) as typeof globalThis.fetch, async () => {
        await assert.rejects(
          () => instance.chat([{ role: 'user', content: 'ping' }], { temperature: 0 }),
          (err: any) => {
            assert.ok(!String(err.message).includes(secretKey), `${name} must redact leaked API key`);
            assert.ok(!String(err.message).includes('\x1b'), `${name} must sanitize ANSI escapes`);
            if (name === 'openrouter') {
              assert.ok(err instanceof OpenRouterRateLimitError);
              assert.equal(err.retryAfterMs, 7_000);
            } else {
              assert.ok(err instanceof ProviderHttpError);
              assert.equal(err.status, 429);
              assert.equal(err.retryAfterMs, 7_000);
            }
            return true;
          }
        );

        const body = JSON.parse(String(capturedInit?.body));
        const sentTemp = name === 'ollama' ? body.options.temperature : body.temperature;
        assert.equal(sentTemp, 0, `${name} must preserve temperature 0`);
        if (name === 'dashscope') {
          assert.equal(body.model, 'qwen3-coder-custom', 'DashScope BYOK must not silently override user-chosen model');
        }
      });
    }
  });

  it('fails fast on missing cloud API keys while permitting keyless loopback OpenAI-compatible servers', async () => {
    await assert.rejects(() => new AnthropicProvider({ model: 'claude-3-5-sonnet' }).chat([{ role: 'user', content: 'hi' }]), /API key/i);
    await assert.rejects(() => new GeminiProvider({ model: 'gemini-2.5-pro' }).chat([{ role: 'user', content: 'hi' }]), /API key/i);
    await assert.rejects(() => new OpenAIProvider({ model: 'gpt-4o' }).chat([{ role: 'user', content: 'hi' }]), /API key/i);
    await assert.rejects(() => new QwenByokProvider({ model: 'qwen3.7-plus' }).chat([{ role: 'user', content: 'hi' }]), /API key/i);
    await assert.rejects(() => new DashscopeByokProvider({ model: 'qwen3.7-plus' }).chat([{ role: 'user', content: 'hi' }]), /API key/i);

    // Keyless local loopback OpenAI-compatible server omits Authorization header cleanly
    let sentHeaders: Record<string, string> = {};
    await withMockFetch((async (_url, init) => {
      sentHeaders = (init?.headers as Record<string, string>) || {};
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'local ok' } }],
        usage: { prompt_tokens: 2, completion_tokens: 2 }
      }), { status: 200 });
    }) as typeof globalThis.fetch, async () => {
      const local = new OpenAICompatibleProvider({
        baseUrl: 'http://127.0.0.1:8080/v1/chat/completions',
        model: 'local-llama'
      });
      const res = await local.chat([{ role: 'user', content: 'hi' }]);
      assert.equal(res.content, 'local ok');
      assert.equal(sentHeaders['Authorization'], undefined, 'keyless loopback server must not receive "Bearer undefined"');
    });
  });
});
