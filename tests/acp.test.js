import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { AcpServer } from '../src/acp/server.js';

function makeHarness(loopFactory) {
  const messages = [];
  const output = {
    write(chunk) {
      for (const line of String(chunk).split('\n')) {
        if (line.trim()) messages.push(JSON.parse(line));
      }
      return true;
    }
  };
  const server = new AcpServer({ output, loopFactory });
  const send = (message) => server.handleLine(JSON.stringify(message));
  const find = (predicate) => messages.filter(predicate);
  const waitFor = async (predicate, timeoutMs = 3000) => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const match = messages.find(predicate);
      if (match) return match;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error('timed out waiting for message');
  };
  return { server, send, messages, find, waitFor };
}

async function newSession(h, id = 1, cwd = process.cwd()) {
  await h.send({ jsonrpc: '2.0', id, method: 'session/new', params: { cwd, mcpServers: [] } });
  const response = await h.waitFor((message) => message.id === id);
  return response;
}

test('initialize advertises only implemented capabilities', async () => {
  const h = makeHarness();
  await h.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientInfo: { name: 'test-client' } } });
  const response = await h.waitFor((message) => message.id === 1);
  const capabilities = response.result.agentCapabilities;
  assert.equal(response.result.protocolVersion, 1);
  assert.equal(response.result.agentInfo.name, 'Causyne Agent');
  assert.equal(capabilities.loadSession, false);
  assert.equal(capabilities.promptCapabilities.image, false);
  assert.equal(capabilities.mcpCapabilities.http, false);
  assert.deepEqual(Object.keys(capabilities.sessionCapabilities).sort(), ['close', 'list']);
  assert.equal(capabilities.sessions, undefined);
  assert.equal(capabilities.fork, undefined);
});

test('initialize rejects a missing protocol version', async () => {
  const h = makeHarness();
  await h.send({ jsonrpc: '2.0', id: 7, method: 'initialize', params: {} });
  const response = await h.waitFor((message) => message.id === 7);
  assert.equal(response.error.code, -32602);
});

test('session/new returns modes and rejects unsupported inputs', async () => {
  const h = makeHarness();
  const response = await newSession(h);
  assert.equal(typeof response.result.sessionId, 'string');
  assert.ok(response.result.sessionId.length > 0);
  assert.equal(response.result.modes.currentModeId, 'standard');
  assert.deepEqual(response.result.modes.availableModes.map((mode) => mode.id), ['autonomous', 'standard', 'supervised']);
  assert.equal(response.result.configOptions, undefined);

  await h.send({
    jsonrpc: '2.0',
    id: 2,
    method: 'session/new',
    params: { cwd: process.cwd(), mcpServers: [{ name: 'x', command: 'x' }] }
  });
  const rejected = await h.waitFor((message) => message.id === 2);
  assert.equal(rejected.error.code, -32602);
});

test('session/new refuses a second workspace in the same server', async () => {
  const h = makeHarness();
  await newSession(h);
  await h.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: os.tmpdir(), mcpServers: [] } });
  const response = await h.waitFor((message) => message.id === 2);
  assert.equal(response.error.code, -32602);
  assert.match(response.error.message, /one workspace per server/);
});

test('session/prompt streams agent text and ends the turn', async () => {
  const loopFactory = ({ sink }) => ({
    setAutonomyMode() {},
    waitForDecision: async () => null,
    handleApprovalResponse() {},
    abort() {},
    async run() {
      sink.send(JSON.stringify({ type: 'agent_message', content: 'hello from the loop' }));
      sink.send(JSON.stringify({ type: 'step_start', tool: 'fs_read', args: { path: 'a.js' }, toolCallId: 'call-1' }));
      sink.send(JSON.stringify({ type: 'step_complete', tool: 'fs_read', result: { success: true }, toolCallId: 'call-1' }));
    }
  });
  const h = makeHarness(loopFactory);
  const sessionResponse = await newSession(h);
  const sessionId = sessionResponse.result.sessionId;

  const line = JSON.stringify({
    jsonrpc: '2.0',
    id: 9,
    method: 'session/prompt',
    params: { sessionId, prompt: [{ type: 'text', text: 'hi' }] }
  });
  await h.server.handleLine(line);
  const response = await h.waitFor((message) => message.id === 9);
  assert.deepEqual(response.result, { stopReason: 'end_turn' });

  const updates = h.find((message) => message.method === 'session/update').map((message) => message.params.update);
  const chunks = updates.filter((update) => update.sessionUpdate === 'agent_message_chunk');
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].content.text, 'hello from the loop');
  const toolStart = updates.find((update) => update.sessionUpdate === 'tool_call');
  assert.equal(toolStart.toolCallId, 'call-1');
  assert.equal(toolStart.status, 'in_progress');
  const toolEnd = updates.find((update) => update.sessionUpdate === 'tool_call_update');
  assert.equal(toolEnd.status, 'completed');
});

test('session/prompt refuses non-text content and unknown sessions', async () => {
  const h = makeHarness();
  const sessionResponse = await newSession(h);
  const sessionId = sessionResponse.result.sessionId;

  await h.send({
    jsonrpc: '2.0',
    id: 3,
    method: 'session/prompt',
    params: { sessionId, prompt: [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }] }
  });
  const refused = await h.waitFor((message) => message.id === 3);
  assert.deepEqual(refused.result, { stopReason: 'refusal' });

  await h.send({ jsonrpc: '2.0', id: 4, method: 'session/prompt', params: { sessionId: 'missing', prompt: [{ type: 'text', text: 'x' }] } });
  const missing = await h.waitFor((message) => message.id === 4);
  assert.equal(missing.error.code, -32002);
});

test('approval requests bridge to session/request_permission', async () => {
  let approvalResolved = null;
  const loopFactory = ({ sink }) => ({
    setAutonomyMode() {},
    waitForDecision: async () => null,
    handleApprovalResponse(toolCallId, approved) {
      approvalResolved = { toolCallId, approved };
    },
    abort() {},
    async run() {
      sink.send(JSON.stringify({
        type: 'approval_request',
        toolCallId: 'call-7',
        tool: 'sysRun',
        args: { command: 'rm -rf build' },
        risk: 'dangerous'
      }));
      const start = Date.now();
      while (!approvalResolved && Date.now() - start < 3000) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  });
  const h = makeHarness(loopFactory);
  const sessionResponse = await newSession(h);
  const sessionId = sessionResponse.result.sessionId;

  const promptPromise = h.server.handleLine(JSON.stringify({
    jsonrpc: '2.0',
    id: 11,
    method: 'session/prompt',
    params: { sessionId, prompt: [{ type: 'text', text: 'clean up' }] }
  }));

  const permissionRequest = await h.waitFor((message) => message.method === 'session/request_permission');
  assert.equal(permissionRequest.params.sessionId, sessionId);
  assert.equal(permissionRequest.params.toolCall.toolCallId, 'call-7');
  assert.deepEqual(permissionRequest.params.options.map((option) => option.optionId), ['allow_once', 'reject_once']);

  await h.send({
    jsonrpc: '2.0',
    id: permissionRequest.id,
    result: { outcome: { outcome: 'selected', optionId: 'allow_once' } }
  });

  await promptPromise;
  const response = await h.waitFor((message) => message.id === 11);
  assert.deepEqual(response.result, { stopReason: 'end_turn' });
  assert.deepEqual(approvalResolved, { toolCallId: 'call-7', approved: true });
});

test('session/cancel aborts the running loop and reports cancelled', async () => {
  let aborted = false;
  const loopFactory = () => ({
    setAutonomyMode() {},
    waitForDecision: async () => null,
    handleApprovalResponse() {},
    abort() {
      aborted = true;
    },
    async run() {
      const start = Date.now();
      while (!aborted && Date.now() - start < 3000) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
  });
  const h = makeHarness(loopFactory);
  const sessionResponse = await newSession(h);
  const sessionId = sessionResponse.result.sessionId;

  const promptPromise = h.server.handleLine(JSON.stringify({
    jsonrpc: '2.0',
    id: 12,
    method: 'session/prompt',
    params: { sessionId, prompt: [{ type: 'text', text: 'long task' }] }
  }));
  await new Promise((resolve) => setTimeout(resolve, 30));
  await h.server.handleLine(JSON.stringify({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } }));

  await promptPromise;
  const response = await h.waitFor((message) => message.id === 12);
  assert.deepEqual(response.result, { stopReason: 'cancelled' });
  assert.equal(aborted, true);
});

test('session/set_mode validates mode and emits a mode update', async () => {
  const h = makeHarness();
  const sessionResponse = await newSession(h);
  const sessionId = sessionResponse.result.sessionId;

  await h.send({ jsonrpc: '2.0', id: 5, method: 'session/set_mode', params: { sessionId, modeId: 'supervised' } });
  const response = await h.waitFor((message) => message.id === 5);
  assert.deepEqual(response.result, {});
  const update = await h.waitFor((message) => message.method === 'session/update'
    && message.params.update.sessionUpdate === 'current_mode_update');
  assert.equal(update.params.update.currentModeId, 'supervised');

  await h.send({ jsonrpc: '2.0', id: 6, method: 'session/set_mode', params: { sessionId, modeId: 'nope' } });
  const invalid = await h.waitFor((message) => message.id === 6);
  assert.equal(invalid.error.code, -32602);
});

test('session/list, session/close, and unsupported session/load', async () => {
  const h = makeHarness();
  const sessionResponse = await newSession(h);
  const sessionId = sessionResponse.result.sessionId;

  await h.send({ jsonrpc: '2.0', id: 8, method: 'session/list', params: {} });
  const list = await h.waitFor((message) => message.id === 8);
  assert.equal(list.result.sessions.length, 1);
  assert.equal(list.result.sessions[0].sessionId, sessionId);
  assert.equal(list.result.sessions[0].cwd, fs.realpathSync(process.cwd()));

  await h.send({ jsonrpc: '2.0', id: 9, method: 'session/close', params: { sessionId } });
  const closed = await h.waitFor((message) => message.id === 9);
  assert.deepEqual(closed.result, {});

  await h.send({ jsonrpc: '2.0', id: 10, method: 'session/load', params: { sessionId, cwd: process.cwd(), mcpServers: [] } });
  const load = await h.waitFor((message) => message.id === 10);
  assert.equal(load.error.code, -32601);
});

test('unknown methods and malformed lines produce JSON-RPC errors', async () => {
  const h = makeHarness();
  await h.send({ jsonrpc: '2.0', id: 20, method: 'nonexistent/method', params: {} });
  const unknown = await h.waitFor((message) => message.id === 20);
  assert.equal(unknown.error.code, -32601);

  await h.server.handleLine('{not json');
  const parseError = await h.waitFor((message) => message.error && message.error.code === -32700);
  assert.equal(parseError.id, null);
});
