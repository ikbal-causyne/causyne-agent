import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AcpProvider } from '../src/providers/acp.js';
import { AcpClient } from '../src/acp/client.js';
import { testPeerHandshake, isAuthRequiredHandshakeFailure } from '../src/acp/agentCatalog.js';
import { AgentLoop } from '../src/agentLoop.js';
import {
  OllamaProvider,
  clearOllamaModelMetaCache,
  computeAdaptiveOllamaNumCtx,
  ollamaOriginUrl
} from '../src/providers/ollama.js';
import { streamOllamaChat, streamOpenAICompatibleChat } from '../src/providers/byokStream.js';
import { ProviderHttpError } from '../src/providers/byokHttp.js';
import { fetchLiveModels } from '../src/dynamicCatalogue.js';
import { OpenRouterProvider, parseRateLimitResetMs } from '../src/providers/openrouter.js';
import { handleInput } from '../src/commands.js';
import { AntigravityProvider } from '../src/providers/antigravity.js';
import {
  listLocalOllamaDiskModels,
  pickPreferredLocalOllamaModel,
  detectZeroCostProviders,
  pickBestZeroCostProvider
} from '../src/zeroCostRouting.js';
import { detectEnvironmentProvider } from '../src/config.js';
import { LLMProvider } from '../src/providers/base.js';
import { OpenAIProvider } from '../src/providers/openai.js';
import { DeepSeekProvider } from '../src/providers/deepseek.js';
import { MoonshotProvider } from '../src/providers/moonshot.js';
import { classifyAgentError } from '../src/agent/errorClassifier.js';

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-w2-')));

after(() => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
});

function createFakeAcpServerScript(dir: string, scriptBody: string): string {
  const file = path.join(dir, `peer_${Math.random().toString(36).slice(2, 8)}.mjs`);
  fs.writeFileSync(file, scriptBody, 'utf8');
  return file;
}

describe('Wave 2 — Zero-API-Key & Free-Tier Reliability', () => {
  test('AcpProvider ignores native bash argument validation errors instead of falsely aborting with sysRun toolRoutingError', async () => {
    const ws = path.join(TMP, 'acp-bash-param');
    fs.mkdirSync(ws, { recursive: true });
    const cancelsFile = path.join(ws, 'cancels.txt');
    const serverScript = createFakeAcpServerScript(ws, `
      import fs from 'node:fs';
      import readline from 'node:readline';
      const rl = readline.createInterface({ input: process.stdin });
      const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
      rl.on('line', (line) => {
        if (!line.trim()) return;
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'opencode', version: '1.0' }, agentCapabilities: {} } });
        } else if (msg.method === 'session/new') {
          send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's1' } });
        } else if (msg.method === 'session/set_model') {
          send({ jsonrpc: '2.0', id: msg.id, result: {} });
        } else if (msg.method === 'session/cancel') {
          fs.appendFileSync(${JSON.stringify(cancelsFile)}, 'cancel\\n');
        } else if (msg.method === 'session/prompt') {
          send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'tool_call', toolCallId: 't1', title: 'invalid', status: 'failed', rawInput: { tool: 'bash', error: 'Invalid arguments: required property command missing' } } } });
          send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'tool_call', toolCallId: 't2', title: 'bash', kind: 'execute', status: 'completed', rawInput: { command: 'echo ok' } } } });
          send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done executing echo ok.' } } } });
          send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
        }
      });
    `);

    const provider = new AcpProvider({
      peer: 'opencode',
      command: process.execPath,
      args: [serverScript]
    });
    try {
      const res = await provider.chat([{ role: 'user', content: 'Run echo ok' }], {
        workspaceRoot: ws,
        tools: [{ name: 'sysRun', description: 'Run command', parameters: { type: 'object', properties: { command: { type: 'string' } } } }]
      });
      assert.equal(res.toolRoutingError, undefined, 'native bash validation error must not trigger host toolRoutingError');
      assert.equal(fs.existsSync(cancelsFile), false, 'session/cancel must not be emitted on native validation error');
      assert.match(res.content, /Done executing echo ok/);
    } finally {
      await provider.close();
    }
  });

  test('AcpClient exposes response.error.data and redacted stderrTail on JSON-RPC -32603 Internal error', async () => {
    const ws = path.join(TMP, 'acp-hermes-err');
    fs.mkdirSync(ws, { recursive: true });
    const fakeKey = 'sk-' + '1234567890abcdef123456';
    const serverScript = createFakeAcpServerScript(ws, `
      import readline from 'node:readline';
      const rl = readline.createInterface({ input: process.stdin });
      const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
      rl.on('line', (line) => {
        if (!line.trim()) return;
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'hermes', version: '0.21' }, agentCapabilities: {} } });
        } else if (msg.method === 'session/new') {
          process.stderr.write('AuthError: Unknown provider opencode-free token=' + ${JSON.stringify(fakeKey)} + '\\n');
          setTimeout(() => {
            send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Internal error', data: { details: 'Provider auth not configured' } } });
          }, 20);
        }
      });
    `);

    const client = new AcpClient({ command: process.execPath, args: [serverScript], cwd: ws });
    try {
      await client.start();
      await assert.rejects(
        () => client.newSession(ws),
        (err: Error) => {
          assert.match(err.message, /Provider auth not configured/);
          assert.match(err.message, /AuthError: Unknown provider opencode-free/);
          assert.equal(err.message.includes(fakeKey), false, 'stderr secret must be redacted');
          return true;
        }
      );
    } finally {
      await client.close();
    }
  });

  test('testPeerHandshake bounds session/new with shared timeout and classifies Hermes/authMethods as needs_auth', async () => {
    const ws = path.join(TMP, 'acp-handshake-timeout');
    fs.mkdirSync(ws, { recursive: true });
    const slowSessionScript = createFakeAcpServerScript(ws, `
      import readline from 'node:readline';
      const rl = readline.createInterface({ input: process.stdin });
      const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
      rl.on('line', (line) => {
        if (!line.trim()) return;
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'slow-peer', version: '1.0' }, authMethods: [{ id: 'api-key' }], agentCapabilities: {} } });
        }
        // Intentionally never answer session/new to verify shared timeout bounds it
      });
    `);

    const start = Date.now();
    const res = await testPeerHandshake({
      command: process.execPath,
      args: [slowSessionScript],
      cwd: ws,
      timeoutMs: 1000
    });
    const elapsed = Date.now() - start;
    assert.equal(res.ready, false);
    assert.ok(elapsed < 4000, `handshake hung ${elapsed}ms instead of timing out at ~1s`);
    assert.match(res.error || '', /timed out/i);
    assert.equal(isAuthRequiredHandshakeFailure({ ready: false, error: 'Session creation failed: Unknown provider opencode-free' }), true);
    assert.equal(isAuthRequiredHandshakeFailure({ ready: false, authMethods: ['oauth'], error: 'Session creation failed: Internal error' }), true);
  });

  test('AcpClient handles stdin EPIPE cleanly, places notices under _meta, and closes child on init failure', async () => {
    const ws = path.join(TMP, 'acp-init-clean');
    fs.mkdirSync(ws, { recursive: true });
    const initPayloadFile = path.join(ws, 'init.json');
    const serverScript = createFakeAcpServerScript(ws, `
      import fs from 'node:fs';
      import readline from 'node:readline';
      const rl = readline.createInterface({ input: process.stdin });
      const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
      rl.on('line', (line) => {
        if (!line.trim()) return;
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          fs.writeFileSync(${JSON.stringify(initPayloadFile)}, JSON.stringify(msg.params));
          send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Init rejected' } });
        }
      });
    `);

    const client = new AcpClient({ command: process.execPath, args: [serverScript], cwd: ws });
    await assert.rejects(() => client.start(), /Init rejected/);
    const initParams = JSON.parse(fs.readFileSync(initPayloadFile, 'utf8'));
    assert.equal(initParams.clientCapabilities.session, undefined, 'non-standard session capability must live under _meta');
    assert.equal(initParams.clientCapabilities._meta?.session?.notices, true);
    // Writing cancel after close/exit must not throw EPIPE
    assert.doesNotThrow(() => client.notifyCancel('s1'));
  });

  test('AcpClient drain dispatches permission requests concurrently without head-of-line blocking or false inactivity stall', async () => {
    const ws = path.join(TMP, 'acp-no-hol');
    fs.mkdirSync(ws, { recursive: true });
    const serverScript = createFakeAcpServerScript(ws, `
      import readline from 'node:readline';
      const rl = readline.createInterface({ input: process.stdin });
      const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
      let promptId = null;
      rl.on('line', (line) => {
        if (!line.trim()) return;
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'hol', version: '1.0' }, agentCapabilities: {} } });
        } else if (msg.method === 'session/new') {
          send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's1' } });
        } else if (msg.method === 'session/prompt') {
          promptId = msg.id;
          // Emit permission request AND immediately emit a streaming chunk before permission resolves
          send({ jsonrpc: '2.0', id: 99, method: 'session/request_permission', params: { sessionId: 's1', toolCall: { toolCallId: 't1', title: 'run', kind: 'execute' }, options: [{ optionId: 'ok', name: 'Allow', kind: 'allow_once' }] } });
          send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'concurrent-stream ' } } } });
        } else if (msg.id === 99 && msg.result) {
          send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'after-approval' } } } });
          send({ jsonrpc: '2.0', id: promptId, result: { stopReason: 'end_turn' } });
        }
      });
    `);

    const chunksDuringPermission: string[] = [];
    let releaseApproval!: () => void;
    const approvalGate = new Promise<void>(r => { releaseApproval = r; });

    const client = new AcpClient({
      command: process.execPath,
      args: [serverScript],
      cwd: ws,
      inactivityTimeoutMs: 120,
      onUpdate: (_sid, update) => {
        if (update.sessionUpdate === 'agent_message_chunk' && update.content && typeof update.content === 'object' && 'text' in update.content) {
          chunksDuringPermission.push(String((update.content as { text: unknown }).text));
          if (String((update.content as { text: unknown }).text).includes('concurrent-stream')) {
            // Wait longer than inactivityTimeoutMs (120ms) to verify inactivity timer pauses during approval
            setTimeout(() => releaseApproval(), 220);
          }
        }
      },
      permissionHandler: async () => {
        await approvalGate;
        return { outcome: 'selected', optionId: 'ok' };
      }
    });
    try {
      await client.start();
      const sid = await client.newSession(ws);
      const res = await client.prompt(sid, 'test');
      assert.ok(chunksDuringPermission.includes('concurrent-stream '), 'stream chunk must arrive while permission request is pending');
      assert.equal(res.text, 'concurrent-stream after-approval');
    } finally {
      await client.close();
    }
  });

  test('AcpClient scrubs CAUSYNE_DEV_TOKEN and AcpProvider does not respawn on fatal quota/auth errors', async () => {
    const ws = path.join(TMP, 'acp-env-no-respawn');
    fs.mkdirSync(ws, { recursive: true });
    const countFile = path.join(ws, 'spawns.txt');
    const envFile = path.join(ws, 'env.json');
    const serverScript = createFakeAcpServerScript(ws, `
      import fs from 'node:fs';
      import readline from 'node:readline';
      fs.appendFileSync(${JSON.stringify(countFile)}, '1\\n');
      fs.writeFileSync(${JSON.stringify(envFile)}, JSON.stringify({
        vault: process.env.CAUSYNE_VAULT_KEY || null,
        devSecret: process.env.CAUSYNE_DEV_SECRET || null,
        devToken: process.env.CAUSYNE_DEV_TOKEN || null
      }));
      const rl = readline.createInterface({ input: process.stdin });
      const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\\n');
      rl.on('line', (line) => {
        if (!line.trim()) return;
        const msg = JSON.parse(line);
        if (msg.method === 'initialize') {
          send({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: 1, agentInfo: { name: 'quota-test', version: '1.0' }, agentCapabilities: {} } });
        } else if (msg.method === 'session/new') {
          send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 's1' } });
        } else if (msg.method === 'session/set_model') {
          send({ jsonrpc: '2.0', id: msg.id, result: {} });
        } else if (msg.method === 'session/prompt') {
          send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: 'Free usage limit reached' } });
        }
      });
    `);

    const prevToken = process.env.CAUSYNE_DEV_TOKEN;
    process.env.CAUSYNE_DEV_TOKEN = 'secret-dev-token-xyz';
    const provider = new AcpProvider({ peer: 'opencode', command: process.execPath, args: [serverScript] });
    try {
      await assert.rejects(() => provider.chat([{ role: 'user', content: 'hi' }], { workspaceRoot: ws }), /Free usage limit reached/);
      const spawns = fs.readFileSync(countFile, 'utf8').trim().split('\n');
      assert.equal(spawns.length, 1, 'must not respawn peer on fatal quota error');
      const capturedEnv = JSON.parse(fs.readFileSync(envFile, 'utf8'));
      assert.equal(capturedEnv.devToken, null, 'CAUSYNE_DEV_TOKEN must be scrubbed from ACP child env');
    } finally {
      if (prevToken === undefined) delete process.env.CAUSYNE_DEV_TOKEN;
      else process.env.CAUSYNE_DEV_TOKEN = prevToken;
      await provider.close();
    }
  });

  test('AgentLoop.requestPeerPermission returns reject_once instead of cancelling turn on scope denial and guards missing options', async () => {
    const ws = path.join(TMP, 'acp-reject-once');
    fs.mkdirSync(ws, { recursive: true });
    const loop = new AgentLoop(null, 'test-reject-once', null, { workspaceRoot: ws });
    const denied = await loop.requestPeerPermission({
      sessionId: 's1',
      toolCall: { toolCallId: 't1', title: 'read', kind: 'read', rawInput: { path: '/etc/passwd' } },
      options: [
        { optionId: 'allow-1', name: 'Allow', kind: 'allow_once' },
        { optionId: 'reject-1', name: 'Reject', kind: 'reject_once' }
      ]
    });
    assert.deepEqual(denied, { outcome: 'selected', optionId: 'reject-1' });

    // Malformed missing options array must not throw
    const malformed = await loop.requestPeerPermission({
      sessionId: 's1',
      toolCall: { toolCallId: 't2', title: 'read', kind: 'read', rawInput: { path: 'a.txt' } },
      options: undefined as any
    });
    assert.deepEqual(malformed, { outcome: 'cancelled' });
  });

  test('OllamaProvider probes /api/show, injects num_ctx, and marks provider_reported usage', async () => {
    clearOllamaModelMetaCache();
    assert.equal(ollamaOriginUrl('http://127.0.0.1:11434/api/chat'), 'http://127.0.0.1:11434');
    assert.equal(ollamaOriginUrl('http://127.0.0.1:11434/v1/chat/completions'), 'http://127.0.0.1:11434');

    const origFetch = globalThis.fetch;
    const seenPayloads: Array<{ url: string; body: any }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      seenPayloads.push({ url, body });
      if (url.endsWith('/api/show')) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => JSON.stringify({ model_info: { 'qwen2.context_length': 32768 }, capabilities: ['completion', 'tools'] })
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify({
          message: { role: 'assistant', content: 'ready' },
          prompt_eval_count: 412,
          eval_count: 19
        })
      } as unknown as Response;
    }) as typeof fetch;

    try {
      const ollama = new OllamaProvider({ model: 'qwen2.5:latest', baseUrl: 'http://127.0.0.1:11434/api/chat' });
      const res = await ollama.chat([{ role: 'user', content: 'hi' }]);
      assert.equal(res.content, 'ready');
      assert.equal(res.usage.measurement, 'provider_reported');
      assert.equal(res.usage.promptTokens, 412);
      const chatReq = seenPayloads.find(p => p.url.endsWith('/api/chat'));
      assert.equal(chatReq?.body?.options?.num_ctx, 32768);
      assert.equal(chatReq?.body?.keep_alive, '10m');

      // VRAM-adaptive sizing prevents 14B Q4_K_M layer spill on 16 GiB unified-memory hosts
      assert.equal(computeAdaptiveOllamaNumCtx({
        modelContextLength: 32768,
        parameterCount: 14.8e9,
        totalMemoryBytes: 16 * (1024 ** 3),
        estimatedPromptTokens: 2000
      }), 8192);
      // Scales up automatically if prompt actually exceeds 75% of 8K cap
      assert.equal(computeAdaptiveOllamaNumCtx({
        modelContextLength: 32768,
        parameterCount: 14.8e9,
        totalMemoryBytes: 16 * (1024 ** 3),
        estimatedPromptTokens: 7000
      }), 10240);
      // Plenty of RAM (64 GiB) keeps full 32K context window
      assert.equal(computeAdaptiveOllamaNumCtx({
        modelContextLength: 32768,
        parameterCount: 14.8e9,
        totalMemoryBytes: 64 * (1024 ** 3),
        estimatedPromptTokens: 2000
      }), 32768);
      // Explicit OLLAMA_NUM_CTX / config.numCtx always wins
      assert.equal(computeAdaptiveOllamaNumCtx({
        configuredNumCtx: 24576,
        modelContextLength: 32768,
        parameterCount: 14.8e9,
        totalMemoryBytes: 16 * (1024 ** 3)
      }), 24576);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test('OllamaProvider retries without native tools on HTTP 400 "does not support tools" and formats HTTP 404 pull hint', async () => {
    clearOllamaModelMetaCache();
    const origFetch = globalThis.fetch;
    let chatCalls = 0;
    const chatPayloads: any[] = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      if (url.endsWith('/api/show')) {
        return { ok: false, status: 404, headers: new Headers(), text: async () => '' } as unknown as Response;
      }
      chatCalls++;
      chatPayloads.push(body);
      if (body.model === 'missing-model') {
        return {
          ok: false,
          status: 404,
          headers: new Headers(),
          text: async () => JSON.stringify({ error: "model 'missing-model' not found" })
        } as unknown as Response;
      }
      if (body.tools) {
        return {
          ok: false,
          status: 400,
          headers: new Headers(),
          text: async () => JSON.stringify({ error: 'registry.ollama.ai/library/deepseek-r1:latest does not support tools' })
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify({
          message: { role: 'assistant', content: '<tool_call>{"name":"fs_read","arguments":{"path":"README.md"}}</tool_call>' },
          prompt_eval_count: 100,
          eval_count: 20
        })
      } as unknown as Response;
    }) as typeof fetch;

    try {
      const ollama = new OllamaProvider({ model: 'deepseek-r1:latest', baseUrl: 'http://127.0.0.1:11434/api/chat' });
      const tools = [{ name: 'fs_read', description: 'Read file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }];
      const res1 = await ollama.chat([{ role: 'user', content: 'Read README' }], { tools });
      assert.equal(res1.toolCalls?.length, 1);
      assert.equal(res1.toolCalls?.[0]?.function.name, 'fs_read');
      assert.equal(chatCalls, 2, 'first turn retries once without payload.tools');
      assert.equal(chatPayloads[1]?.tools, undefined);

      // Second turn skips native tools directly thanks to memoization
      await ollama.chat([{ role: 'user', content: 'Read again' }], { tools });
      assert.equal(chatCalls, 3, 'second turn must reuse memoized supportsTools=false without extra 400');

      const missing = new OllamaProvider({ model: 'missing-model', baseUrl: 'http://127.0.0.1:11434/api/chat' });
      await assert.rejects(() => missing.chat([{ role: 'user', content: 'hi' }]), /ollama pull missing-model/i);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test('streamOllamaChat merges/dedups tool deltas and fetchLiveModels normalizes /api/chat + prioritizes warm /api/ps models', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url === 'http://127.0.0.1:11434/api/tags') {
        return {
          ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => JSON.stringify({ models: [{ name: 'llama3.1:latest' }, { name: 'qwen2.5:latest' }] })
        } as unknown as Response;
      }
      if (url === 'http://127.0.0.1:11434/api/ps') {
        return {
          ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => JSON.stringify({ models: [{ name: 'qwen2.5:latest' }] })
        } as unknown as Response;
      }
      const ndjson = [
        JSON.stringify({ message: { role: 'assistant', content: '', tool_calls: [{ id: 'tc1', function: { name: 'fs_read', arguments: '{"path":' } }] }, done: false }),
        JSON.stringify({ message: { role: 'assistant', content: '', tool_calls: [{ id: 'tc1', function: { name: 'fs_read', arguments: '"a.ts"}' } }] }, done: false }),
        JSON.stringify({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'fs_read', arguments: '{"path":"a.ts"}' } }] }, done: true, prompt_eval_count: 10, eval_count: 5 })
      ].join('\n') + '\n';
      const encoder = new TextEncoder();
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(ndjson));
          controller.close();
        }
      });
      return {
        ok: true, status: 200,
        headers: new Headers({ 'content-type': 'application/x-ndjson' }),
        body
      } as unknown as Response;
    }) as typeof fetch;

    try {
      const models = await fetchLiveModels('ollama', { baseUrl: 'http://127.0.0.1:11434/api/chat' });
      assert.deepEqual(models, ['qwen2.5', 'llama3.1'], 'warm /api/ps model must be ordered first and /api/chat stripped');

      const streamed = await streamOllamaChat({
        url: 'http://127.0.0.1:11434/api/chat',
        providerLabel: 'Ollama',
        payload: { model: 'qwen2.5', messages: [] }
      });
      const calls = (streamed.message as any)?.tool_calls;
      assert.equal(calls.length, 1, 'split delta + duplicate final tool_call must collapse into 1');
      assert.equal(calls[0].function.arguments, '{"path":"a.ts"}');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test('OpenRouterProvider enforces require_parameters, parses X-RateLimit-Reset, rotates :free models on 429, and falls back to XML tools', async () => {
    const now = 1_700_000_000_000;
    assert.equal(parseRateLimitResetMs(String(now + 12_000), now), 12_000);

    const origFetch = globalThis.fetch;
    const requestedModels: string[] = [];
    const seenBodies: any[] = [];
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body || '{}'));
      requestedModels.push(body.model);
      seenBodies.push(body);
      if (body.model === 'openrouter/free') {
        return {
          ok: false, status: 429,
          headers: new Headers({ 'x-ratelimit-reset': String(Date.now() + 5000) }),
          text: async () => JSON.stringify({ error: { message: 'Rate limited' } })
        } as unknown as Response;
      }
      if (body.tools) {
        return {
          ok: false, status: 404,
          headers: new Headers(),
          text: async () => JSON.stringify({ error: { message: 'No endpoints found that support tool use' } })
        } as unknown as Response;
      }
      return {
        ok: true, status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify({
          choices: [{ message: { role: 'assistant', content: '<tool_call>{"name":"fs_read","arguments":{"path":"x.ts"}}</tool_call>' } }],
          usage: { prompt_tokens: 50, completion_tokens: 15 }
        })
      } as unknown as Response;
    }) as typeof fetch;

    try {
      const provider = new OpenRouterProvider({ apiKey: 'or-test-key-123456', model: 'openrouter/free' });
      const tools = [{ name: 'fs_read', description: 'Read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }];
      const res = await provider.chat([{ role: 'user', content: 'read x.ts' }], { tools });
      assert.equal(seenBodies[0]?.provider?.require_parameters, true, 'must set require_parameters when tools attached');
      assert.equal(requestedModels[0], 'openrouter/free');
      assert.ok(requestedModels[1]?.endsWith(':free'), 'fallback must strictly use a :free model');
      assert.equal(res.toolCalls?.[0]?.function.name, 'fs_read');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test('OpenRouter streaming preserves tool arguments without tc.index, extracts reasoning_details, and /openrouter allow/deny shorthand works', async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      const sse = [
        'data: ' + JSON.stringify({ choices: [{ delta: { reasoning_details: [{ type: 'reasoning.text', text: 'plan step' }] } }] }),
        'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: 'tc_or_1', function: { name: 'fs_read', arguments: '{"path":' } }] } }] }),
        'data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{ function: { arguments: '"README.md"}' } }] } }] }),
        'data: [DONE]'
      ].join('\n\n') + '\n\n';
      const encoder = new TextEncoder();
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(sse));
          controller.close();
        }
      });
      return {
        ok: true, status: 200,
        headers: new Headers({ 'content-type': 'text/event-stream' }),
        body
      } as unknown as Response;
    }) as typeof fetch;

    const reasoningChunks: string[] = [];
    try {
      const provider = new OpenRouterProvider({ apiKey: 'or-test-key-123456', model: 'openrouter/free' });
      const res = await provider.chat([{ role: 'user', content: 'read' }], {
        onChunk: () => {},
        onReasoningChunk: (d) => reasoningChunks.push(d)
      });
      assert.equal(reasoningChunks.join(''), 'plan step');
      assert.equal(res.toolCalls?.length, 1);
      assert.equal(res.toolCalls?.[0]?.function.name, 'fs_read');
      assert.equal(res.toolCalls?.[0]?.function.arguments, '{"path":"README.md"}');

      const allowCmd = await handleInput('/openrouter allow', {}) as any;
      assert.equal(allowCmd.ok, true);
      assert.match(allowCmd.output || '', /"allow"/);
      const denyCmd = await handleInput('/openrouter deny', {}) as any;
      assert.equal(denyCmd.ok, true);
      assert.match(denyCmd.output || '', /"deny"/);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test('AgentLoop honors retryAfterMs on 429 rate_limit retries up to 5 attempts without polluting KV cache messages', async () => {
    const ws = path.join(TMP, 'loop-429-retry');
    fs.mkdirSync(ws, { recursive: true });
    const loop = new AgentLoop(null, 'test-429', 'Say hello briefly.', { workspaceRoot: ws }) as any;
    const seenDelays: number[] = [];
    loop.backoff = async (_attempt: number, retryAfterMs?: number) => {
      seenDelays.push(retryAfterMs ?? -1);
    };
    let attempts = 0;
    const model = {
      model: 'openrouter/free',
      supportsVision: false,
      chat: async () => {
        attempts++;
        if (attempts < 4) {
          const err: any = new Error('Rate limited 429');
          err.status = 429;
          err.retryAfterMs = 2500;
          throw err;
        }
        return {
          content: 'Recovered cleanly after three 429 rate limits.',
          usage: { promptTokens: 20, completionTokens: 10, measurement: 'provider_reported' }
        };
      }
    };
    loop.initializeProvider = () => model;
    loop.llm = model;
    await loop.run();
    assert.equal(attempts, 4, 'must allow >3 attempts on rate_limit (up to 5)');
    assert.deepEqual(seenDelays, [2500, 2500, 2500], 'must pass retryAfterMs to backoff');
    const injectedRecovered = (loop.messages || []).some(
      (m: any) => m?.role === 'system' && String(m.content || '').includes('SYSTEM ERROR RECOVERED')
    );
    assert.equal(injectedRecovered, false, '429 retries must not push SYSTEM ERROR RECOVERED into messages');
  });

  test('AntigravityProvider handles chunk-split <think> tags, scrubs vault env, and resolves promptly on result event', { skip: process.platform === 'win32' }, async () => {
    const ws = path.join(TMP, 'agy-stream-fixes');
    fs.mkdirSync(ws, { recursive: true });
    const envOut = path.join(ws, 'agy-env.json');
    const fakeAgy = path.join(ws, 'fake-agy.mjs');
    fs.writeFileSync(fakeAgy, `#!/usr/bin/env node
import fs from 'node:fs';
fs.writeFileSync(${JSON.stringify(envOut)}, JSON.stringify({
  vault: process.env.CAUSYNE_VAULT_KEY || null,
  dev: process.env.CAUSYNE_DEV_SECRET || null
}));
process.stdin.resume();
const emit = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
emit({ event: 'init', conversation_id: 'conv-agy-1' });
emit({ event: 'step_update', step_update: { step_type: 'text', text_delta: '<thi' } });
emit({ event: 'step_update', step_update: { step_type: 'text', text_delta: 'nk>hidden thought</thi' } });
emit({ event: 'step_update', step_update: { step_type: 'text', text_delta: 'nk>Visible answer!' } });
emit({ event: 'result', result: { status: 'SUCCESS', conversation_id: 'conv-agy-1', response: '', usage: { input_tokens: 100, output_tokens: 20 } } });
// Keep process open briefly to verify provider resolves promptly on result event without waiting forever
setTimeout(() => process.exit(0), 9000);
`, 'utf8');
    if (process.platform !== 'win32') fs.chmodSync(fakeAgy, 0o755);

    const prevVault = process.env.CAUSYNE_VAULT_KEY;
    process.env.CAUSYNE_VAULT_KEY = 'secret-vault-key-test';
    const visibleChunks: string[] = [];
    const thinkChunks: string[] = [];
    const provider = new AntigravityProvider({ command: fakeAgy, model: 'gemini-3.8-flash-low' });
    const start = Date.now();
    try {
      const res = await provider.chat([{ role: 'user', content: 'Say answer' }], {
        workspaceRoot: ws,
        onChunk: (c) => visibleChunks.push(c),
        onReasoningChunk: (r) => thinkChunks.push(r)
      });
      const elapsed = Date.now() - start;
      assert.ok(elapsed < 6000, `expected prompt resolution on result event, took ${elapsed}ms`);
      assert.equal(visibleChunks.join(''), 'Visible answer!');
      assert.equal(thinkChunks.join(''), 'hidden thought');
      assert.equal(res.content, 'Visible answer!');
      assert.equal(res.incompleteTurn, undefined);
      const envData = JSON.parse(fs.readFileSync(envOut, 'utf8'));
      assert.equal(envData.vault, null, 'CAUSYNE_VAULT_KEY must be scrubbed from agy child env');
    } finally {
      if (prevVault === undefined) delete process.env.CAUSYNE_VAULT_KEY;
      else process.env.CAUSYNE_VAULT_KEY = prevVault;
    }
  });

  test('AntigravityProvider persistentWorker reuses one warm process across turns and terminates cleanly on close()', { skip: process.platform === 'win32' }, async () => {
    const ws = path.join(TMP, 'agy-persistent-worker');
    fs.mkdirSync(ws, { recursive: true });
    const spawnLog = path.join(ws, 'spawns.txt');
    const fakeAgy = path.join(ws, 'fake-agy-warm.mjs');
    fs.writeFileSync(fakeAgy, `#!/usr/bin/env node
import fs from 'node:fs';
import readline from 'node:readline';
fs.appendFileSync(${JSON.stringify(spawnLog)}, String(process.pid) + '\\n');
const rl = readline.createInterface({ input: process.stdin });
let turn = 0;
rl.on('line', (line) => {
  if (!line.trim()) return;
  turn++;
  process.stdout.write(JSON.stringify({ event: 'init', conversation_id: 'warm-conv-1' }) + '\\n');
  process.stdout.write(JSON.stringify({
    event: 'result',
    result: { status: 'SUCCESS', conversation_id: 'warm-conv-1', response: 'Reply #' + turn, usage: { input_tokens: 10 * turn, output_tokens: 5 * turn } }
  }) + '\\n');
});
`, 'utf8');
    fs.chmodSync(fakeAgy, 0o755);

    const provider = new AntigravityProvider({
      command: fakeAgy,
      model: 'gemini-3.8-flash-low',
      persistentWorker: true
    });
    try {
      const r1 = await provider.chat([{ role: 'user', content: 'Turn 1' }], { workspaceRoot: ws });
      const r2 = await provider.chat([{ role: 'user', content: 'Turn 1' }, { role: 'assistant', content: 'Reply #1' }, { role: 'user', content: 'Turn 2' }], { workspaceRoot: ws });
      assert.equal(r1.content, 'Reply #1');
      assert.equal(r2.content, 'Reply #2');
      const pids = fs.readFileSync(spawnLog, 'utf8').trim().split('\n');
      assert.equal(pids.length, 1, 'persistentWorker must reuse a single warm agy process across turns');
    } finally {
      await provider.close();
    }
  });

  test('zeroCostRouting discovers local Ollama disk models, prioritizes coding models, and detects OPENROUTER_API_KEY', async () => {
    const fakeOllamaDir = path.join(TMP, 'ollama-models');
    const libDir = path.join(fakeOllamaDir, 'manifests', 'registry.ollama.ai', 'library');
    fs.mkdirSync(path.join(libDir, 'llama3.1'), { recursive: true });
    fs.mkdirSync(path.join(libDir, 'qwen2.5-coder'), { recursive: true });
    fs.writeFileSync(path.join(libDir, 'llama3.1', 'latest'), '{}');
    fs.writeFileSync(path.join(libDir, 'qwen2.5-coder', '7b'), '{}');

    const diskModels = listLocalOllamaDiskModels(fakeOllamaDir);
    assert.deepEqual(diskModels, ['qwen2.5-coder:7b', 'llama3.1']);
    assert.equal(pickPreferredLocalOllamaModel(diskModels), 'qwen2.5-coder:7b');

    const discovered = await detectZeroCostProviders({
      env: { OPENROUTER_API_KEY: 'or-free-test-key-999999', PATH: '' },
      ollamaModelsDir: fakeOllamaDir,
      probeOllama: false
    });
    const orEntry = discovered.find((d) => d.id === 'openrouter-free');
    assert.equal(orEntry?.readiness, 'ready');
    assert.equal(pickBestZeroCostProvider(discovered)?.id, 'openrouter-free');

    const savedKeys = {
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
      GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
      XAI_API_KEY: process.env.XAI_API_KEY,
      GROK_API_KEY: process.env.GROK_API_KEY,
      MOONSHOT_API_KEY: process.env.MOONSHOT_API_KEY,
      DASHSCOPE_API_KEY: process.env.DASHSCOPE_API_KEY,
      QWEN_API_KEY: process.env.QWEN_API_KEY,
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY
    };
    try {
      for (const k of Object.keys(savedKeys)) delete process.env[k];
      process.env.OPENROUTER_API_KEY = 'or-free-env-key-123456';
      const envDetected = detectEnvironmentProvider();
      assert.equal(envDetected?.provider, 'openrouter-free');
      assert.equal(envDetected?.model, 'openrouter/free');
    } finally {
      for (const [k, v] of Object.entries(savedKeys)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  test('LLMProvider strips internal fields, strict providers strip reasoning_content, usage marks provider_reported, and errorClassifier handles context_overflow & skill wording', () => {
    const base = new LLMProvider({});
    const oai = new OpenAIProvider({});
    const ollama = new OllamaProvider({});
    const ds = new DeepSeekProvider({});
    const ms = new MoonshotProvider({});
    assert.equal(base.preserveReasoningContent, true);
    assert.equal(oai.preserveReasoningContent, false);
    assert.equal(ollama.preserveReasoningContent, false);
    assert.equal(ds.preserveReasoningContent, true);
    assert.equal(ms.preserveReasoningContent, true);

    const stripped = oai.stripInternalFields([
      {
        role: 'assistant',
        content: 'ok',
        reasoning_content: 'hidden',
        causyne_synthetic_no_final: true,
        external_actions: [{ name: 'x' }],
        cacheAnchor: true
      }
    ]);
    assert.equal('reasoning_content' in stripped[0], false);
    assert.equal('causyne_synthetic_no_final' in stripped[0], false);
    assert.equal('external_actions' in stripped[0], false);
    assert.equal('cacheAnchor' in stripped[0], false);

    const dsStripped = ds.stripInternalFields([{ role: 'assistant', content: 'ok', reasoning_content: 'keep me', causyne_synthetic_no_final: true }]);
    assert.equal(dsStripped[0].reasoning_content, 'keep me');
    assert.equal('causyne_synthetic_no_final' in dsStripped[0], false);

    const usage = base.normalizeUsage({ prompt_tokens: 120, completion_tokens: 30 });
    assert.equal(usage.measurement, 'provider_reported');

    assert.equal(classifyAgentError({ status: 413, message: 'Payload too large' }), 'context_overflow');
    assert.equal(classifyAgentError({ status: 400, message: 'maximum context length exceeded' }), 'context_overflow');
    assert.equal(classifyAgentError({ status: 404, message: 'model not found' }), 'invalid_request_error');
    assert.equal(classifyAgentError({ status: 422, message: 'unprocessable entity' }), 'invalid_request_error');
    assert.equal(classifyAgentError({ status: 529, message: 'overloaded_error' }), 'network_error');
    assert.equal(classifyAgentError({ name: 'TimeoutError', message: 'timed out' }), 'network_error');
    assert.equal(classifyAgentError(new Error('Failed to parse skill header')), 'unknown_error', '"skill" must never match "kill" as fatal');
    assert.equal(classifyAgentError(new Error('Process killed by SIGKILL')), 'fatal');
  });

  test('streamOpenAICompatibleChat retries without stream_options on 400 and throws ProviderHttpError on mid-stream overload/rate_limit', async () => {
    const origFetch = globalThis.fetch;
    const seenBodies: any[] = [];
    let callCount = 0;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      callCount++;
      const body = JSON.parse(String(init?.body || '{}'));
      seenBodies.push(body);
      if (callCount === 1) {
        return {
          ok: false,
          status: 400,
          headers: new Headers(),
          text: async () => JSON.stringify({ error: { message: 'Unrecognized request argument: stream_options' } })
        } as unknown as Response;
      }
      if (callCount === 2) {
        const sse = 'data: ' + JSON.stringify({ choices: [{ delta: { content: 'hello local' } }] }) + '\n\ndata: [DONE]\n\n';
        const enc = new TextEncoder();
        const stream = new ReadableStream({
          start(c) {
            c.enqueue(enc.encode(sse));
            c.close();
          }
        });
        return {
          ok: true, status: 200,
          headers: new Headers({ 'content-type': 'text/event-stream' }),
          body: stream
        } as unknown as Response;
      }
      const errSse = 'data: ' + JSON.stringify({ error: { type: 'overloaded_error', message: 'Upstream overloaded' } }) + '\n\n';
      const enc = new TextEncoder();
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(enc.encode(errSse));
          c.close();
        }
      });
      return {
        ok: true, status: 200,
        headers: new Headers({ 'content-type': 'text/event-stream' }),
        body: stream
      } as unknown as Response;
    }) as typeof fetch;

    try {
      const ok = await streamOpenAICompatibleChat({
        url: 'http://127.0.0.1:1234/v1/chat/completions',
        providerLabel: 'LocalLLM',
        payload: { model: 'local', messages: [{ role: 'user', content: 'hi' }] }
      });
      assert.equal(seenBodies[0]?.stream_options?.include_usage, true);
      assert.equal(seenBodies[1]?.stream_options, undefined, 'retry must omit unsupported stream_options');
      assert.equal((ok.choices as any)?.[0]?.message?.content, 'hello local');

      await assert.rejects(
        () => streamOpenAICompatibleChat({
          url: 'http://127.0.0.1:1234/v1/chat/completions',
          providerLabel: 'LocalLLM',
          payload: { model: 'local', messages: [{ role: 'user', content: 'hi' }] }
        }),
        (err: unknown) => {
          assert.ok(err instanceof ProviderHttpError, 'mid-stream overloaded_error must throw ProviderHttpError');
          assert.equal((err as ProviderHttpError).status, 529);
          assert.equal(classifyAgentError(err), 'network_error');
          return true;
        }
      );
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
