import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AcpProvider } from '../src/providers/acp.js';
import { AcpClient } from '../src/acp/client.js';

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
});
