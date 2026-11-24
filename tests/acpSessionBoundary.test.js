import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AcpClient } from '../src/acp/client.js';

const READ = 'fs/read_text_file';
const WRITE = 'fs/write_text_file';
const PERMISSION = 'session/request_permission';
const allowed = { optionId: 'allow', kind: 'allow_once', name: 'Allow' };
const denied = { optionId: 'deny', kind: 'reject_once', name: 'Deny' };

function harness(options = {}) {
  const client = new AcpClient({ command: process.execPath, cwd: process.cwd(), ...options });
  client.promptActive = 'active';
  client.promptGeneration = 1;
  const responses = [];
  client.write = message => responses.push(message);
  const call = async (method, params) => {
    const id = 'request-' + (responses.length + 1);
    await client.handleServerRequest({ jsonrpc: '2.0', id, method, params });
    return responses.find(response => response.id === id);
  };
  return { client, responses, call };
}
function permission(sessionId = 'active', overrides = {}) {
  return { sessionId, toolCall: { toolCallId: 'native-1', kind: 'edit', title: 'Edit a file' }, options: [allowed, denied], ...overrides };
}
async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'causyne-acp-boundary-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('foreign read requests never reach the host file handler', async () => {
  let reads = 0;
  const h = harness({ fsReadHandler: async () => { reads++; return 'private data'; } });
  const result = await h.call(READ, { sessionId: 'foreign', path: 'a.txt' });
  assert.equal(reads, 0);
  assert.equal(result.error.code, -32600);
});

test("foreign writes cannot mutate host files", async () => {
  let writes = 0;
  const h = harness({ fsWriteHandler: async () => { writes++; } });
  const result = await h.call(WRITE, { sessionId: 'foreign', path: 'a.txt', content: 'changed' });
  assert.equal(writes, 0);
  assert.equal(result.error.code, -32600);
});

test("host file access is refused outside any prompt", async () => {
  const h = harness({ fsReadHandler: async () => assert.fail('must not read') });
  h.client.promptActive = null;
  assert.equal((await h.call(READ, { sessionId: 'active', path: 'a.txt' })).error.code, -32600);
});

test("host writes are refused when native file tools are disabled", async () => {
  const h = harness({ allowHostTools: false, fsWriteHandler: async () => assert.fail('must not write') });
  const result = await h.call(WRITE, { sessionId: 'active', path: 'a.txt', content: 'x' });
  assert.equal(result.error.code, -32600);
  assert.match(result.error.message, /advertised Causyne tools/);
});

test("foreign permission requests bypass the user approval UI", async () => {
  const h = harness({ permissionHandler: async () => assert.fail('must not ask') });
  const result = await h.call(PERMISSION, permission('foreign'));
  assert.deepEqual(result.result.outcome, { outcome: 'cancelled' });
});
