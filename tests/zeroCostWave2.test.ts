import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AcpProvider } from '../src/providers/acp.js';
import { AcpClient } from '../src/acp/client.js';
import { testPeerHandshake, isAuthRequiredHandshakeFailure } from '../src/acp/agentCatalog.js';
import { AgentLoop } from '../src/agentLoop.js';
import { OllamaProvider, clearOllamaModelMetaCache, ollamaOriginUrl } from '../src/providers/ollama.js';

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
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
