import test from 'node:test';
import assert from 'node:assert/strict';
import { AcpClient } from '../src/acp/client.js';

function peer(result) {
  const script = 'const r = require("node:readline").createInterface({ input: process.stdin }); r.on("line", line => { const req = JSON.parse(line); process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: req.id, result: ' + JSON.stringify(result) + ' }) + "\\n"); });';
  return new AcpClient({ command: process.execPath, args: ['-e', script], cwd: process.cwd() });
}

test('initialize refuses missing or unsupported protocol versions', async () => {
  for (const result of [null, {}, { protocolVersion: 2 }, { protocolVersion: '1' }]) {
    const client = peer(result);
    try { await assert.rejects(client.start(), /unsupported protocol version/); }
    finally { await client.close(); }
  }
});

test('initialize accepts the supported protocol version', async () => {
  const client = peer({ protocolVersion: 1, agentCapabilities: {} });
  try { assert.equal((await client.start()).protocolVersion, 1); }
  finally { await client.close(); }
});

test('initialize refuses malformed negotiated capabilities', async () => {
  for (const agentCapabilities of [null, [], 'invalid', true]) {
    const client = peer({ protocolVersion: 1, agentCapabilities });
    try { await assert.rejects(client.start(), /malformed agent capabilities/); }
    finally { await client.close(); }
  }
});
