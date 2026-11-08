/**
 * Causyne Agent — OpenRouter Free Integration Tests
 *
 * Verifies the complete OpenRouter Free implementation:
 * 1. Cryptographic PKCE S256 verification and authorization URL generation
 * 2. Token exchange with official endpoint
 * 3. Loopback callback server lifecycle and state CSRF verification
 * 4. Secure credential vault storage and masking
 * 5. Strict zero-cost cost guard (FreeModeCostGuardError rejection of paid models)
 * 6. Privacy enforcement (default provider.data_collection: "deny")
 * 7. Rate limit and quota exhaustion (HTTP 429) handling without paid fallback
 * 8. Non-streaming and streaming SSE chat completion
 * 9. Tool calling adaptation and error tolerance
 * 10. Dynamic catalog filtering for live zero-cost models
 * 11. Model router utility routing
 * 12. Slash command /openrouter operation
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';

import {
  generatePkceCodes,
  buildAuthorizationUrl,
  exchangeCodeForApiKey,
  startLoopbackAuth,
  maskApiKey,
  saveOpenRouterKey,
  disconnectOpenRouter,
  getOpenRouterStatus,
  setOpenRouterDataCollection,
  renderAuthPage,
  getLogoBuffer,
  OpenRouterAuthError,
  OPENROUTER_AUTH_URL,
  OPENROUTER_FREE_MODEL
} from '../src/auth/openrouterAuth.js';

import {
  OpenRouterProvider,
  FreeModeCostGuardError,
  OpenRouterRateLimitError,
  OpenRouterPrivacyConstraintError,
  OPENROUTER_CHAT_ENDPOINT
} from '../src/providers/openrouter.js';

import {
  normalizeProviderKey,
  fetchLiveModels,
  getAvailableProvidersOverview
} from '../src/dynamicCatalogue.js';

import {
  MODEL_CATALOGUE,
  DEFAULT_MODEL_BY_PROVIDER,
  UTILITY_MODEL_BY_PROVIDER,
  allCatalogueModels
} from '../src/modelCatalogue.js';

import { resolveRoute } from '../src/modelRouter.js';
import { handleInput } from '../src/commands.js';
import {
  buildModelPickerItems,
  ModelPickerLayer,
  runInteractiveModelPicker
} from '../src/tui/modelPicker.js';

describe('OpenRouter Free — PKCE Cryptography & Authorization', () => {
  test('PKCE generates RFC 7636 compliant verifier, challenge and CSRF state', () => {
    const pkce = generatePkceCodes();

    assert.ok(pkce.codeVerifier.length >= 43, 'Verifier must be at least 43 characters');
    assert.equal(pkce.codeChallengeMethod, 'S256', 'Must use S256 challenge method');

    // Verify SHA-256 calculation
    const expectedChallenge = crypto
      .createHash('sha256')
      .update(pkce.codeVerifier)
      .digest('base64url');
    assert.equal(pkce.codeChallenge, expectedChallenge, 'Challenge must match S256 hash of verifier');

    assert.ok(pkce.state.length >= 32, 'CSRF state must be at least 32 hex chars');
  });

  test('buildAuthorizationUrl constructs standard URL with required parameters', () => {
    const callback = 'http://127.0.0.1:45123/callback';
    const challenge = 'test_challenge_hash';
    const state = 'test_csrf_state';

    const authUrl = buildAuthorizationUrl(callback, challenge, state);
    const parsed = new URL(authUrl);

    assert.equal(parsed.origin, 'https://openrouter.ai');
    assert.equal(parsed.pathname, '/auth');
    assert.equal(parsed.searchParams.get('callback_url'), callback);
    assert.equal(parsed.searchParams.get('code_challenge'), challenge);
    assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(parsed.searchParams.get('state'), state);
  });

  test('exchangeCodeForApiKey exchanges auth code via POST to OpenRouter auth keys', async () => {
    let capturedUrl = '';
    let capturedBody: any = null;
    let capturedHeaders: any = null;

    const mockFetch = async (url: any, init: any) => {
      capturedUrl = String(url);
      capturedBody = JSON.parse(init.body);
      capturedHeaders = init.headers;
      return new Response(JSON.stringify({ key: 'mock_auth_key_12345' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    };

    const key = await exchangeCodeForApiKey('auth_code_xyz', 'verifier_abc', mockFetch as any);

    assert.equal(capturedUrl, 'https://openrouter.ai/api/v1/auth/keys');
    assert.equal(capturedBody.code, 'auth_code_xyz');
    assert.equal(capturedBody.code_verifier, 'verifier_abc');
    assert.equal(capturedBody.code_challenge_method, 'S256');
    assert.equal(capturedHeaders['HTTP-Referer'], 'https://causyne.com');
    assert.equal(key, 'mock_auth_key_12345');
  });

  test('exchangeCodeForApiKey throws descriptive OpenRouterAuthError on failure', async () => {
    const mockFetch = async () => {
      return new Response('Invalid code verifier', { status: 400 });
    };

    await assert.rejects(
      async () => exchangeCodeForApiKey('bad_code', 'bad_verifier', mockFetch as any),
      OpenRouterAuthError
    );
  });
});

describe('OpenRouter Free — Loopback Callback Server', () => {
  test('loopback server handles callback redirect, verifies state, and exchanges code', async () => {
    let serverUrl = '';

    const mockFetch = async () => {
      return new Response(JSON.stringify({ key: 'mock_loopback_key_999' }), { status: 200 });
    };

    const loopbackPromise = startLoopbackAuth({
      timeoutMs: 5000,
      openBrowser: false,
      fetchFn: mockFetch as any,
      onUrlReady: (url) => {
        serverUrl = url;
      }
    });

    // Wait for server to bind
    for (let i = 0; i < 50; i++) {
      if (serverUrl) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(serverUrl, 'Server URL should be initialized');

    const parsed = new URL(serverUrl);
    const callbackUrl = parsed.searchParams.get('callback_url')!;
    const state = parsed.searchParams.get('state')!;

    // Send mock browser callback request
    const response = await fetch(`${callbackUrl}?code=test_auth_code&state=${state}`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.ok(html.includes('Causyne Agent Connected Successfully'));

    const result = await loopbackPromise;
    assert.equal(result.apiKey, 'mock_loopback_key_999');
  });

  test('loopback server rejects CSRF state mismatch with HTTP 400', async () => {
    let serverUrl = '';

    const loopbackPromise = startLoopbackAuth({
      timeoutMs: 5000,
      openBrowser: false,
      fetchFn: (async () => new Response('{}')) as any,
      onUrlReady: (url) => {
        serverUrl = url;
      }
    });

    for (let i = 0; i < 50; i++) {
      if (serverUrl) break;
      await new Promise((r) => setTimeout(r, 10));
    }

    const parsed = new URL(serverUrl);
    const callbackUrl = parsed.searchParams.get('callback_url')!;

    // Send callback with forged state and verify rejection and HTTP 400
    const [response] = await Promise.all([
      fetch(`${callbackUrl}?code=test_code&state=forged_csrf_state`),
      assert.rejects(loopbackPromise, OpenRouterAuthError)
    ]);
    assert.equal(response.status, 400);
  });
});

describe('OpenRouter Free — Credential Storage & Masking', () => {
  test('saveOpenRouterKey stores key in providerKeys with default deny data collection', () => {
    let savedConfig: any = null;
    const mockStore = {
      loadConfig: () => ({ provider: 'deepseek', model: 'deepseek-chat', providerKeys: {} }),
      saveConfig: (cfg: any) => { savedConfig = cfg; }
    };

    saveOpenRouterKey('mock_api_key_vault_secret', {
      setAsActive: true,
      store: mockStore
    });

    assert.equal(savedConfig.provider, 'openrouter');
    assert.equal(savedConfig.model, 'openrouter/free');
    assert.equal(savedConfig.apiKey, 'mock_api_key_vault_secret');
    assert.equal(savedConfig.providerKeys.openrouter, 'mock_api_key_vault_secret');
    assert.equal(savedConfig.openrouterDataCollection, 'deny');
  });

  test('getOpenRouterStatus masks API keys and discloses active status', () => {
    const config = {
      provider: 'openrouter',
      model: 'openrouter/free',
      apiKey: 'or-test-mock-auth-key-vault-abc123',
      providerKeys: { openrouter: 'or-test-mock-auth-key-vault-abc123' },
      openrouterDataCollection: 'deny'
    };

    const status = getOpenRouterStatus(config);
    assert.equal(status.connected, true);
    assert.equal(status.active, true);
    assert.equal(status.model, 'openrouter/free');
    assert.equal(status.dataCollection, 'deny');
    assert.ok(status.maskedKey?.includes('...'));
    assert.ok(!status.maskedKey?.includes('abcdef123456'));
  });

  test('disconnectOpenRouter clears key and reverts active provider safely', () => {
    let savedConfig: any = null;
    const mockStore = {
      loadConfig: () => ({
        provider: 'openrouter',
        model: 'openrouter/free',
        apiKey: 'key_to_delete',
        providerKeys: { openrouter: 'key_to_delete', deepseek: 'deepseek_key' }
      }),
      saveConfig: (cfg: any) => { savedConfig = cfg; }
    };

    disconnectOpenRouter(mockStore);

    assert.equal(savedConfig.provider, 'deepseek');
    assert.equal(savedConfig.model, 'deepseek-chat');
    assert.equal(savedConfig.providerKeys.openrouter, undefined);
    assert.equal(savedConfig.apiKey, 'deepseek_key');
  });
});

describe('OpenRouter Free — Cost Guard & Zero-Cost Boundaries', () => {
  test('OpenRouterProvider permits openrouter/free and :free models', () => {
    const free1 = new OpenRouterProvider({ apiKey: 'k', model: 'openrouter/free' });
    assert.equal(free1.model, 'openrouter/free');

    const free2 = new OpenRouterProvider({ apiKey: 'k', model: 'meta-llama/llama-3.3-70b-instruct:free' });
    assert.equal(free2.model, 'meta-llama/llama-3.3-70b-instruct:free');
  });

  test('OpenRouterProvider strictly throws FreeModeCostGuardError for paid models in free mode', () => {
    assert.throws(
      () => new OpenRouterProvider({ apiKey: 'k', model: 'openai/gpt-4o' }),
      FreeModeCostGuardError
    );

    assert.throws(
      () => new OpenRouterProvider({ apiKey: 'k', model: 'anthropic/claude-3-5-sonnet' }),
      FreeModeCostGuardError
    );

    assert.throws(
      () => new OpenRouterProvider({ apiKey: 'k', model: 'google/gemini-2.0-flash' }),
      FreeModeCostGuardError
    );
  });

  test('chat() strictly rejects non-free model if altered after construction', async () => {
    const provider = new OpenRouterProvider({ apiKey: 'k', model: 'openrouter/free' });
    provider.model = 'openai/gpt-4o'; // simulate mutation

    await assert.rejects(
      async () => provider.chat([{ role: 'user', content: 'test' }]),
      FreeModeCostGuardError
    );
  });
});

describe('OpenRouter Free — Privacy & Data Collection Restriction', () => {
  test('request payload sets provider.data_collection to "deny" by default', async () => {
    let capturedBody: any = null;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => {
      capturedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'Hello free world' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      }), { status: 200 });
    }) as any;

    try {
      const provider = new OpenRouterProvider({ apiKey: 'mock_test_key', model: 'openrouter/free' });
      const res = await provider.chat([{ role: 'user', content: 'hello' }]);

      assert.equal(res.content, 'Hello free world');
      assert.equal(capturedBody.model, 'openrouter/free');
      assert.equal(capturedBody.provider?.data_collection, 'deny');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('request payload sets provider.data_collection to "allow" only when explicitly configured', async () => {
    let capturedBody: any = null;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => {
      capturedBody = JSON.parse(init.body);
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'Training opt-in route' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
      }), { status: 200 });
    }) as any;

    try {
      const provider = new OpenRouterProvider({
        apiKey: 'mock_test_key',
        model: 'openrouter/free',
        openrouterDataCollection: 'allow'
      });
      await provider.chat([{ role: 'user', content: 'hello' }]);

      assert.equal(capturedBody.provider?.data_collection, 'allow');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('privacy constraint error from OpenRouter is surfaced cleanly', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ error: { message: 'No provider available for the requested model and data collection preference' } }), {
        status: 400
      });
    }) as any;

    try {
      const provider = new OpenRouterProvider({ apiKey: 'mock_test_key', model: 'openrouter/free' });
      await assert.rejects(
        async () => provider.chat([{ role: 'user', content: 'hello' }]),
        OpenRouterPrivacyConstraintError
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('OpenRouter Free — Rate Limit & Quota Exhaustion', () => {
  test('HTTP 429 throws OpenRouterRateLimitError without falling back to paid models', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ error: { message: 'Free model rate limit exceeded' } }), {
        status: 429
      });
    }) as any;

    try {
      const provider = new OpenRouterProvider({ apiKey: 'mock_test_key', model: 'openrouter/free' });
      await assert.rejects(
        async () => provider.chat([{ role: 'user', content: 'hello' }]),
        OpenRouterRateLimitError
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('OpenRouter Free — Streaming & Tool Calling', () => {
  test('chat() handles streaming SSE chunks and reasoning', async () => {
    const ssePayload = [
      'data: {"choices":[{"delta":{"content":"Free "}}]}\n\n',
      'data: {"choices":[{"delta":{"reasoning":"Analyzing query..."}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"streaming!"}}]}\n\n',
      'data: {"usage":{"prompt_tokens":12,"completion_tokens":4,"total_tokens":16}}\n\n',
      'data: [DONE]\n\n'
    ].join('');

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(ssePayload));
          controller.close();
        }
      });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }) as any;

    try {
      const provider = new OpenRouterProvider({ apiKey: 'mock_test_key', model: 'openrouter/free' });
      const chunks: string[] = [];
      const thoughts: string[] = [];

      const res = await provider.chat([{ role: 'user', content: 'stream test' }], {
        onChunk: (c) => chunks.push(c),
        onReasoningChunk: (r) => thoughts.push(r)
      });

      assert.equal(res.content, 'Free streaming!');
      assert.equal(res.reasoningContent, 'Analyzing query...');
      assert.deepEqual(chunks, ['Free ', 'streaming!']);
      assert.deepEqual(thoughts, ['Analyzing query...']);
      assert.equal(res.usage.promptTokens, 12);
      assert.equal(res.usage.completionTokens, 4);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('chat() adapts tools and parses returned tool calls safely', async () => {
    const originalFetch = globalThis.fetch;
    let sentTools: any = null;

    globalThis.fetch = (async (url: any, init: any) => {
      const parsed = JSON.parse(init.body);
      sentTools = parsed.tools;
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: '',
            tool_calls: [{
              id: 'call_123',
              type: 'function',
              function: {
                name: 'fs_read',
                arguments: '{"path":"README.md"}'
              }
            }]
          }
        }],
        usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 }
      }), { status: 200 });
    }) as any;

    try {
      const provider = new OpenRouterProvider({ apiKey: 'mock_test_key', model: 'openrouter/free' });
      const tools = [{
        name: 'fs_read',
        description: 'Read file',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }
      }];

      const res = await provider.chat([{ role: 'user', content: 'read readme' }], { tools });

      assert.ok(Array.isArray(sentTools), 'Tools should be adapted for OpenAI schema');
      assert.equal(sentTools[0].function.name, 'fs_read');
      assert.equal(res.toolCalls?.length, 1);
      assert.equal(res.toolCalls![0]?.function.name, 'fs_read');
      assert.equal(res.toolCalls![0]?.function.arguments, '{"path":"README.md"}');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('OpenRouter Free — Dynamic Catalogue & Routing', () => {
  test('normalizeProviderKey recognizes openrouter and openrouter-free', () => {
    assert.equal(normalizeProviderKey('openrouter'), 'openrouter');
    assert.equal(normalizeProviderKey('openrouter-free'), 'openrouter');
    assert.equal(normalizeProviderKey('OpenRouter'), 'openrouter');
  });

  test('modelCatalogue offers openrouter/free in catalogue, default and utility tables', () => {
    assert.ok(allCatalogueModels().includes('openrouter/free'));
    assert.equal(DEFAULT_MODEL_BY_PROVIDER['openrouter'], 'openrouter/free');
    assert.equal(UTILITY_MODEL_BY_PROVIDER['openrouter'], 'openrouter/free');
  });

  test('resolveRoute keeps utility work on openrouter/free at zero cost', () => {
    const config = { provider: 'openrouter', model: 'openrouter/free' };
    const route = resolveRoute(config, 'utility');
    assert.equal(route.provider, 'openrouter');
    assert.equal(route.model, 'openrouter/free');
  });

  test('fetchLiveModels for openrouter strictly returns canonical openrouter/free router model without polling transient endpoints', async () => {
    const models = await fetchLiveModels('openrouter', { apiKey: 'test_k' });
    assert.deepEqual(models, ['openrouter/free']);
  });
});

describe('OpenRouter Free — Slash Command /openrouter', () => {
  test('/openrouter status reports connection details', async () => {
    const res = await handleInput('/openrouter status', {
      loadConfig: () => ({ provider: 'openrouter', model: 'openrouter/free' })
    } as any);

    assert.equal(res.ok, true);
    assert.ok(res.output.includes('OpenRouter Free Models — Connection Status'));
    assert.ok(res.output.includes('provider.data_collection'));
  });

  test('/openrouter privacy updates data collection setting', async () => {
    const resDeny = await handleInput('/openrouter privacy deny', {} as any);
    assert.equal(resDeny.ok, true);
    assert.ok(resDeny.output.includes('Strict privacy active'));

    const resAllow = await handleInput('/openrouter privacy allow', {} as any);
    assert.equal(resAllow.ok, true);
    assert.ok(resAllow.output.includes('Notice: Setting data_collection to "allow"'));
  });

  test('/openrouter connect with direct key saves key and activates openrouter/free', async () => {
    const res = await handleInput('/openrouter connect test_direct_api_key_123', {} as any);
    assert.equal(res.ok, true);
    assert.ok(res.output.includes('Saved OpenRouter API key and switched active model to openrouter/free'));
  });

  test('/openrouter disconnect removes key', async () => {
    const res = await handleInput('/openrouter disconnect', {} as any);
    assert.equal(res.ok, true);
    assert.ok(res.output.includes('disconnected and API key removed'));
  });
});

describe('OpenRouter Free — TUI Model Picker Integration & HTML Branding', () => {
  test('renderAuthPage renders professional HTML with logo and CAUSYNE AGENT branding', () => {
    const successHtml = renderAuthPage({
      status: 'success',
      model: OPENROUTER_FREE_MODEL
    });

    assert.ok(successHtml.includes('CAUSYNE <span style="color:#9df028;">AGENT</span>'));
    assert.ok(successHtml.includes('Connected Successfully'));
    assert.ok(successHtml.includes('OpenRouter Account Authorized'));
    assert.ok(successHtml.includes('openrouter/free'));
    assert.ok(successHtml.includes('Return to Terminal'));

    const errorHtml = renderAuthPage({
      status: 'error',
      title: 'State Mismatch',
      errorDetail: 'The CSRF token was invalid.'
    });

    assert.ok(errorHtml.includes('CAUSYNE <span style="color:#9df028;">AGENT</span>'));
    assert.ok(errorHtml.includes('Authorization Failed'));
    assert.ok(errorHtml.includes('Recommended Solutions'));
    assert.ok(errorHtml.includes('causyne config set providerKeys.openrouter'));
  });

  test('loopback server serves /logo.png with valid PNG content', async () => {
    let serverUrl = '';
    const mockFetch = async () => new Response(JSON.stringify({ key: 'test_logo_key' }));
    const loopbackPromise = startLoopbackAuth({
      timeoutMs: 5000,
      openBrowser: false,
      fetchFn: mockFetch as any,
      onUrlReady: (url) => { serverUrl = url; }
    });

    for (let i = 0; i < 50; i++) {
      if (serverUrl) break;
      await new Promise(r => setTimeout(r, 10));
    }

    const parsed = new URL(serverUrl);
    const callbackUrl = parsed.searchParams.get('callback_url')!;
    const state = parsed.searchParams.get('state')!;
    const callbackParsed = new URL(callbackUrl);
    const logoUrl = `http://127.0.0.1:${callbackParsed.port}/logo.png`;

    const res = await fetch(logoUrl);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    const buf = await res.arrayBuffer();
    assert.ok(buf.byteLength > 1000, 'Logo buffer should be non-trivial PNG image');

    // Complete loopback server cleanly
    const [callbackRes, result] = await Promise.all([
      fetch(`${callbackUrl}?code=test_code&state=${state}`),
      loopbackPromise
    ]);
    assert.equal(callbackRes.status, 200);
    assert.equal(result.apiKey, 'test_logo_key');
  });

  test('buildModelPickerItems: categorizes OpenRouter under dedicated FREE tab and excludes from BYOK', () => {
    const config = { provider: 'antigravity', model: 'Gemini 3.8 Flash (Low)' };
    const overview = {
      activeProvider: 'antigravity',
      activeModel: 'Gemini 3.8 Flash (Low)',
      acp: [],
      byok: [
        {
          id: 'anthropic',
          label: 'Anthropic',
          isConfigured: false,
          isCurrent: false,
          models: ['claude-3-7-sonnet'],
          defaultModel: 'claude-3-7-sonnet'
        },
        {
          id: 'openrouter',
          label: 'OpenRouter Free',
          isConfigured: false,
          isCurrent: false,
          models: ['openrouter/free'],
          defaultModel: 'openrouter/free'
        }
      ]
    };

    // Tab byok must NOT include OpenRouter
    const byokItems = buildModelPickerItems(config, overview as any, { tab: 'byok' });
    assert.ok(byokItems.some(i => i.value.providerId === 'anthropic'));
    assert.ok(!byokItems.some(i => i.value.providerId === 'openrouter'));

    // Tab free MUST include OpenRouter
    const freeItems = buildModelPickerItems(config, overview as any, { tab: 'free' });
    assert.ok(freeItems.some(i => i.value.providerId === 'openrouter' && i.label === 'openrouter/free'));
    assert.ok(!freeItems.some(i => i.value.providerId === 'anthropic'));

    // Tab all includes both cleanly
    const allItems = buildModelPickerItems(config, overview as any, { tab: 'all' });
    assert.ok(allItems.some(i => i.value.providerId === 'anthropic'));
    assert.ok(allItems.some(i => i.value.providerId === 'openrouter'));
  });

  test('ModelPickerLayer: renders | ACP | BYOK | FREE | and cycles tabs seamlessly', () => {
    const config = { provider: 'openrouter', model: 'openrouter/free' };
    const overview = {
      activeProvider: 'openrouter',
      activeModel: 'openrouter/free',
      acp: [],
      byok: [
        {
          id: 'openrouter',
          label: 'OpenRouter Free',
          isConfigured: true,
          isCurrent: true,
          models: ['openrouter/free'],
          defaultModel: 'openrouter/free'
        }
      ]
    };

    const layer = new ModelPickerLayer({
      config,
      overview: overview as any,
      onPick: () => {}
    });

    // Initial tab defaults to 'free' because config.provider is 'openrouter'
    assert.equal(layer.activeTab, 'free');
    const rows = layer.body(80, 20);
    assert.ok(rows[0].includes('ACP'));
    assert.ok(rows[0].includes('BYOK'));
    assert.ok(rows[0].includes('● FREE'));

    // Cycle with tab: free -> acp
    layer.key({ name: 'tab' });
    assert.equal(layer.activeTab, 'acp');

    // acp -> byok
    layer.key({ name: 'tab' });
    assert.equal(layer.activeTab, 'byok');

    // byok -> free
    layer.key({ name: 'tab' });
    assert.equal(layer.activeTab, 'free');
  });

  test('runInteractiveModelPicker: accepts pasted API key for OpenRouter Free', async () => {
    let storedConfig: Record<string, any> = { provider: 'antigravity', model: 'Gemini 3.8 Flash (Low)' };
    const mockStore = {
      loadConfig: () => ({ ...storedConfig }),
      saveConfig: (c: any) => { storedConfig = { ...c }; }
    };

    const mockPrompt = {
      openLayer: (layer: any) => {
        if (layer.constructor.name === 'ModelPickerLayer') {
          const item = layer.list.all.find((i: any) => i.value.providerId === 'openrouter');
          assert.ok(item, 'OpenRouter item must be present');
          setTimeout(() => layer.onPick(item), 1);
        } else if (layer.constructor.name === 'InputLayer') {
          setTimeout(() => layer.onSubmit('or-mock-vault-key-12345'), 1);
        }
      }
    };

    const result = await runInteractiveModelPicker(mockPrompt as any, mockStore);
    assert.ok(result.includes('Saved API key. Now using OpenRouter Free'));
    assert.equal(storedConfig.provider, 'openrouter');
    assert.equal(storedConfig.model, 'openrouter/free');
    assert.equal(storedConfig.providerKeys?.openrouter, 'or-mock-vault-key-12345');
  });

  test('buildModelPickerItems: FREE tab strictly exposes openrouter/free and disconnect action when configured', () => {
    // 1. Configured state: exactly 2 items in FREE tab (openrouter/free and disconnect)
    const configuredConfig = {
      provider: 'openrouter',
      model: 'openrouter/free',
      providerKeys: { openrouter: 'test-vault-key' }
    };
    const overview = {
      activeProvider: 'openrouter',
      activeModel: 'openrouter/free',
      acp: [],
      byok: [
        {
          id: 'openrouter',
          label: 'OpenRouter Free',
          isConfigured: true,
          models: ['cohere/free', 'nvidia/free', 'openrouter/free'],
          defaultModel: 'openrouter/free'
        }
      ]
    };

    const freeItems = buildModelPickerItems(configuredConfig, overview as any, { tab: 'free' });
    // Must NOT contain arbitrary individual free models
    assert.equal(freeItems.filter(i => i.value.type === 'free').length, 1);
    assert.equal(freeItems[0].label, 'openrouter/free');
    assert.ok(freeItems.some(i => i.value.action === 'disconnect'), 'Must include disconnect action');

    // 2. Unconfigured state: strictly 1 item (openrouter/free)
    const unconfiguredConfig = { provider: 'antigravity', model: 'Gemini 3.8 Flash (Low)' };
    const unconfItems = buildModelPickerItems(unconfiguredConfig, overview as any, { tab: 'free' });
    assert.equal(unconfItems.length, 1);
    assert.equal(unconfItems[0].label, 'openrouter/free');
    assert.ok(!unconfItems.some(i => i.value.action === 'disconnect'), 'Must not include disconnect action when not configured');
  });

  test('runInteractiveModelPicker: selecting Disconnect OpenRouter unlinks credentials and reverts model', async () => {
    let storedConfig: Record<string, any> = {
      provider: 'openrouter',
      model: 'openrouter/free',
      providerKeys: { openrouter: 'test-vault-key-xyz' }
    };
    const mockStore = {
      loadConfig: () => ({ ...storedConfig }),
      saveConfig: (c: any) => { storedConfig = { ...c }; }
    };

    let promptUpdatedWith: { provider?: string; model?: string } = {};
    const mockPrompt = {
      openLayer: (layer: any) => {
        if (layer.constructor.name === 'ModelPickerLayer') {
          // Select disconnect action
          const item = layer.list.all.find((i: any) => i.value.action === 'disconnect');
          assert.ok(item, 'Disconnect item must exist when configured');
          setTimeout(() => layer.onPick(item), 1);
        }
      },
      updateModel: (p: string, m: string) => {
        promptUpdatedWith = { provider: p, model: m };
      }
    };

    const result = await runInteractiveModelPicker(mockPrompt as any, mockStore);
    assert.ok(result.includes('Disconnected OpenRouter'));
    assert.equal(storedConfig.provider, 'antigravity');
    assert.equal(storedConfig.model, 'Gemini 3.8 Flash (Low)');
    assert.equal(storedConfig.providerKeys?.openrouter, undefined);
    assert.equal(promptUpdatedWith.provider, 'antigravity');
    assert.equal(promptUpdatedWith.model, 'Gemini 3.8 Flash (Low)');
  });
});
