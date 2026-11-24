import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { AcpServer } from '../src/acp/server.js';
import { getSession, saveSessionMessages } from '../src/sessionJournal.js';

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
  const server = new AcpServer({ output, loopFactory, permissionTimeoutMs: 500 });
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
  assert.equal(capabilities.loadSession, true);
  assert.equal(capabilities.promptCapabilities.image, false);
  assert.equal(capabilities.mcpCapabilities.http, false);
  assert.deepEqual(Object.keys(capabilities.sessionCapabilities).sort(), ['close', 'fork', 'list']);
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
  assert.deepEqual(permissionRequest.params.options.map((option) => option.optionId), ['allow_once', 'allow_always', 'reject_once']);

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

test('session/list, session/close, and session/load replay a stored conversation', async () => {
  const h = makeHarness();
  const sessionResponse = await newSession(h);
  const sessionId = sessionResponse.result.sessionId;
  saveSessionMessages(sessionId, [
    { role: 'user', content: 'earlier question' },
    { role: 'assistant', content: 'earlier answer' }
  ]);

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
  assert.equal(load.result.modes.currentModeId, 'standard');
  const replayed = h.find((message) => message.method === 'session/update').map((message) => message.params.update);
  assert.ok(replayed.some((update) => update.sessionUpdate === 'user_message_chunk' && update.content.text === 'earlier question'));
  assert.ok(replayed.some((update) => update.sessionUpdate === 'agent_message_chunk' && update.content.text === 'earlier answer'));

  await h.send({ jsonrpc: '2.0', id: 11, method: 'session/load', params: { sessionId: 'missing', cwd: process.cwd() } });
  const missing = await h.waitFor((message) => message.id === 11);
  assert.equal(missing.error.code, -32002);
});

test('session/fork copies the transcript but never the approvals', async () => {
  let captured = null;
  const loopFactory = (params) => {
    captured = params;
    return {
      setAutonomyMode() {},
      waitForDecision: async () => null,
      handleApprovalResponse() {},
      abort() {},
      async run() {}
    };
  };
  const h = makeHarness(loopFactory);
  const sessionResponse = await newSession(h);
  const sessionId = sessionResponse.result.sessionId;
  saveSessionMessages(sessionId, [
    { role: 'user', content: 'keep this context' },
    { role: 'assistant', content: 'kept' }
  ]);

  await h.send({ jsonrpc: '2.0', id: 12, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'hi' }] } });
  await h.waitFor((message) => message.id === 12);
  assert.ok(captured, 'the loop factory did not receive the session options');
  assert.equal(captured.memorySessionId, sessionId);
  captured.approvalScope.grantAlways('sysRun');
  assert.equal(captured.approvalScope.isAlwaysAllowed('sysRun'), true);

  await h.send({ jsonrpc: '2.0', id: 13, method: 'session/fork', params: { sessionId, cwd: process.cwd() } });
  const fork = await h.waitFor((message) => message.id === 13);
  const forkId = fork.result.sessionId;
  assert.notEqual(forkId, sessionId);
  assert.equal(fork.result.modes.currentModeId, 'standard');

  const copied = getSession(forkId);
  assert.deepEqual(copied.messages.map((message) => message.content), ['keep this context', 'kept']);
  const forkScope = h.server.sessions.get(forkId).approvalScope;
  assert.equal(forkScope.isAlwaysAllowed('sysRun'), false, 'a fork inherited a standing approval');
  assert.equal(captured.approvalScope.isAlwaysAllowed('sysRun'), true, 'the source lost its own approval');
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

test("assistant snapshot wire deduplication", async () => {
  const h = makeHarness(({ sink }) => ({
    setAutonomyMode() {},
    abort() {},
    async run() {
      for (const event of [{"type":"agent_message","streamId":1,"content":"First","streaming":true},{"type":"agent_message","streamId":1,"content":"First second","streaming":true},{"type":"agent_message","streamId":1,"content":"First second","streaming":false}]) sink.send(JSON.stringify(event));
    }
  }));
  const sessionId = (await newSession(h)).result.sessionId;
  await h.send({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'test' }] } });
  const response = await h.waitFor(message => message.id === 2);
  const chunks = kind => h.find(message => message.method === 'session/update' && message.params.update.sessionUpdate === kind).map(message => message.params.update.content.text);
  assert.deepEqual(chunks('agent_message_chunk'), ['First', ' second']);
});

test("independent assistant streams preserve repeated phrases", async () => {
  const h = makeHarness(({ sink }) => ({
    setAutonomyMode() {},
    abort() {},
    async run() {
      for (const event of [{"type":"agent_message","streamId":1,"content":"Same.","streaming":false},{"type":"agent_message","streamId":2,"content":"Same.","streaming":false}]) sink.send(JSON.stringify(event));
    }
  }));
  const sessionId = (await newSession(h)).result.sessionId;
  await h.send({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'test' }] } });
  const response = await h.waitFor(message => message.id === 2);
  const chunks = kind => h.find(message => message.method === 'session/update' && message.params.update.sessionUpdate === kind).map(message => message.params.update.content.text);
  assert.deepEqual(chunks('agent_message_chunk'), ['Same.', 'Same.']);
});

test("assistant stream continues across native tool events", async () => {
  const h = makeHarness(({ sink }) => ({
    setAutonomyMode() {},
    abort() {},
    async run() {
      for (const event of [{"type":"agent_message","streamId":1,"content":"Inspecting.","streaming":true},{"type":"step_start","tool":"fs_read","toolCallId":"read-1","args":{"path":"index.html"}},{"type":"step_complete","tool":"fs_read","toolCallId":"read-1","result":{"success":true}},{"type":"agent_message","streamId":1,"content":"Inspecting. Done.","streaming":false}]) sink.send(JSON.stringify(event));
    }
  }));
  const sessionId = (await newSession(h)).result.sessionId;
  await h.send({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'test' }] } });
  const response = await h.waitFor(message => message.id === 2);
  const chunks = kind => h.find(message => message.method === 'session/update' && message.params.update.sessionUpdate === kind).map(message => message.params.update.content.text);
  assert.deepEqual(chunks('agent_message_chunk'), ['Inspecting.', ' Done.']);
});

test("legacy cumulative assistant streams remain compatible", async () => {
  const h = makeHarness(({ sink }) => ({
    setAutonomyMode() {},
    abort() {},
    async run() {
      for (const event of [{"type":"agent_message","content":"One","streaming":true},{"type":"agent_message","content":"One two","streaming":true},{"type":"agent_message","content":"One two","streaming":false},{"type":"agent_message","content":"One two"}]) sink.send(JSON.stringify(event));
    }
  }));
  const sessionId = (await newSession(h)).result.sessionId;
  await h.send({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'test' }] } });
  const response = await h.waitFor(message => message.id === 2);
  const chunks = kind => h.find(message => message.method === 'session/update' && message.params.update.sessionUpdate === kind).map(message => message.params.update.content.text);
  assert.deepEqual(chunks('agent_message_chunk'), ['One', ' two', 'One two']);
});

test("reasoning final snapshots do not duplicate prior thought chunks", async () => {
  const h = makeHarness(({ sink }) => ({
    setAutonomyMode() {},
    abort() {},
    async run() {
      for (const event of [{"type":"agent_reasoning","content":"Inspect","streaming":true},{"type":"agent_reasoning","content":"Inspect assets","streaming":true},{"type":"agent_reasoning","content":"Inspect assets","streaming":false}]) sink.send(JSON.stringify(event));
    }
  }));
  const sessionId = (await newSession(h)).result.sessionId;
  await h.send({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'test' }] } });
  const response = await h.waitFor(message => message.id === 2);
  const chunks = kind => h.find(message => message.method === 'session/update' && message.params.update.sessionUpdate === kind).map(message => message.params.update.content.text);
  assert.deepEqual(chunks('agent_thought_chunk'), ['Inspect', ' assets']);
});

test("separate reasoning segments preserve repeated text", async () => {
  const h = makeHarness(({ sink }) => ({
    setAutonomyMode() {},
    abort() {},
    async run() {
      for (const event of [{"type":"agent_reasoning","content":"Check.","streaming":true},{"type":"agent_reasoning","content":"Check.","streaming":false},{"type":"agent_reasoning","content":"Check.","streaming":false}]) sink.send(JSON.stringify(event));
    }
  }));
  const sessionId = (await newSession(h)).result.sessionId;
  await h.send({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'test' }] } });
  const response = await h.waitFor(message => message.id === 2);
  const chunks = kind => h.find(message => message.method === 'session/update' && message.params.update.sessionUpdate === kind).map(message => message.params.update.content.text);
  assert.deepEqual(chunks('agent_thought_chunk'), ['Check.', 'Check.']);
});

test("terminal loop errors are not advertised as successful ACP completion", async () => {
  const h = makeHarness(({ sink }) => ({
    setAutonomyMode() {},
    abort() {},
    async run() {
      for (const event of [{"type":"error","message":"Connection ended after partial progress."}]) sink.send(JSON.stringify(event));
    }
  }));
  const sessionId = (await newSession(h)).result.sessionId;
  await h.send({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'test' }] } });
  const response = await h.waitFor(message => message.id === 2);
  const chunks = kind => h.find(message => message.method === 'session/update' && message.params.update.sessionUpdate === kind).map(message => message.params.update.content.text);
  assert.equal(response.result.stopReason, 'refusal');
  assert.deepEqual(chunks('agent_message_chunk'), ['Connection ended after partial progress.']);
});

test("nonterminal warning does not convert an otherwise completed turn into refusal", async () => {
  const h = makeHarness(({ sink }) => ({
    setAutonomyMode() {},
    abort() {},
    async run() {
      for (const event of [{"type":"warning","message":"Temporary tool warning"},{"type":"agent_message","content":"Recovered."}]) sink.send(JSON.stringify(event));
    }
  }));
  const sessionId = (await newSession(h)).result.sessionId;
  await h.send({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'test' }] } });
  const response = await h.waitFor(message => message.id === 2);
  const chunks = kind => h.find(message => message.method === 'session/update' && message.params.update.sessionUpdate === kind).map(message => message.params.update.content.text);
  assert.equal(response.result.stopReason, 'end_turn');
  assert.deepEqual(chunks('agent_message_chunk'), ['Temporary tool warning', 'Recovered.']);
});

test("oversized prompt is refused without executing a truncated request", async () => {
  let runs = 0;
  const h = makeHarness(() => ({ setAutonomyMode() {}, abort() {}, async run() { runs++; } }));
  const sessionId = (await newSession(h)).result.sessionId;
  await h.send({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'x'.repeat(200001) }] } });
  assert.equal((await h.waitFor(message => message.id === 2)).result.stopReason, 'refusal');
  assert.equal(runs, 0);
});

test("prompt size accounts for separators between content blocks", async () => {
  let runs = 0;
  const h = makeHarness(() => ({ setAutonomyMode() {}, abort() {}, async run() { runs++; } }));
  const sessionId = (await newSession(h)).result.sessionId;
  await h.send({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'a'.repeat(100000) }, { type: 'text', text: 'b'.repeat(100000) }] } });
  assert.equal((await h.waitFor(message => message.id === 2)).result.stopReason, 'refusal');
  assert.equal(runs, 0);
});

test("cancelled queued prompts cannot execute after the active turn exits", async () => {
  let release;
  const prompts = [];
  const h = makeHarness(({ userPrompt }) => ({
    setAutonomyMode() {},
    abort() { release?.(); },
    async run() {
      prompts.push(userPrompt);
      if (userPrompt === 'first') await new Promise(resolve => { release = resolve; });
    }
  }));
  const sessionId = (await newSession(h)).result.sessionId;
  const prompt = (id, text) => h.send({ jsonrpc: '2.0', id, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text }] } });
  const first = prompt(2, 'first');
  for (let i = 0; i < 50 && !release; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(typeof release, 'function');
  const queued = prompt(3, 'queued before cancel');
  await h.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
  await Promise.all([first, queued]);
  assert.equal((await h.waitFor(message => message.id === 2)).result.stopReason, 'cancelled');
  assert.equal((await h.waitFor(message => message.id === 3)).result.stopReason, 'cancelled');
  await prompt(4, 'new after cancel');
  assert.equal((await h.waitFor(message => message.id === 4)).result.stopReason, 'end_turn');
  assert.deepEqual(prompts, ['first', 'new after cancel']);
});

test("malformed internal event values cannot abort an otherwise successful loop", async () => {
  const h = makeHarness(({ sink }) => ({
    setAutonomyMode() {}, abort() {},
    async run() {
      for (const value of [null, 123, [], {}, 'unexpected']) sink.send(JSON.stringify(value));
      sink.send(JSON.stringify({ type: 'agent_message', content: 'Valid response.' }));
    }
  }));
  const sessionId = (await newSession(h)).result.sessionId;
  await h.send({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'test' }] } });
  assert.equal((await h.waitFor(message => message.id === 2)).result.stopReason, 'end_turn');
  const chunks = h.find(message => message.params?.update?.sessionUpdate === 'agent_message_chunk');
  assert.deepEqual(chunks.map(message => message.params.update.content.text), ['Valid response.']);
});

test("stopped server cannot allocate new sessions", async () => {
  const h = makeHarness(() => ({ setAutonomyMode() {}, abort() {}, async run() {} }));
  await h.server.stop();
  const count = h.messages.length;
  await h.send({ jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: process.cwd(), mcpServers: [] } });
  assert.equal(h.messages.length, count);
});

test("UTF-8 split across incoming transport buffers retains the exact user prompt", async () => {
  const { PassThrough } = await import('node:stream');
  const input = new PassThrough();
  const replies = [];
  let observed;
  const server = new AcpServer({ input, output: { write(chunk) { replies.push(...String(chunk).trim().split('\n').filter(Boolean).map(JSON.parse)); return true; } },
    loopFactory: ({ userPrompt }) => ({ setAutonomyMode() {}, abort() {}, async run() { observed = userPrompt; } }) });
  try {
    server.start();
    await server.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'session/new', params: { cwd: process.cwd(), mcpServers: [] } }));
    const sessionId = replies.find(reply => reply.id === 1).result.sessionId;
    const original = '检查文件 🌐 café';
    const frame = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: original }] } }) + '\n');
    const split = frame.indexOf(Buffer.from('🌐')) + 1;
    input.write(frame.subarray(0, split));
    input.write(frame.subarray(split));
    for (let i = 0; i < 50 && !replies.some(reply => reply.id === 2); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(observed, original);
    assert.equal(replies.find(reply => reply.id === 2).result.stopReason, 'end_turn');
  } finally { await server.stop(); input.destroy(); }
});

test('failed agent construction releases the session and does not poison the next turn', async () => {
  let attempts = 0;
  const h = makeHarness(() => {
    if (++attempts === 1) throw new Error('simulated construction failure');
    return { setAutonomyMode() {}, abort() {}, async run() {} };
  });
  const sessionId = (await newSession(h)).result.sessionId;
  const prompt = id => h.send({ jsonrpc: '2.0', id, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'test' }] } });
  await prompt(2);
  assert.equal((await h.waitFor(message => message.id === 2)).result.stopReason, 'refusal');
  assert.equal(h.server.sessions.get(sessionId).busy, false);
  assert.equal(h.server.sessions.get(sessionId).loop, null);
  await prompt(3);
  assert.equal((await h.waitFor(message => message.id === 3)).result.stopReason, 'end_turn');
  assert.equal(attempts, 2);
});

test("per-session queue rejects excess prompts without executing them", async () => {
  let release;
  let runs = 0;
  const h = makeHarness(() => ({
    setAutonomyMode() {}, abort() { release?.(); },
    async run() { runs++; await new Promise(resolve => { release = resolve; }); }
  }));
  const sessionId = (await newSession(h)).result.sessionId;
  const prompt = id => h.send({ jsonrpc: '2.0', id, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'work' }] } });
  const pending = Array.from({ length: 32 }, (_, i) => prompt(i + 2));
  try {
    await prompt(34);
    assert.equal((await h.waitFor(message => message.id === 34)).error.code, -32602);
    assert.equal(h.server.sessions.get(sessionId).pendingPrompts, 32);
  } finally {
    await h.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
    await Promise.all(pending);
    await h.server.stop();
  }
  assert.equal(runs, 1);
});

test("global queue limit rejects work even when another session has room", async () => {
  let runs = 0;
  const h = makeHarness(() => {
    let release;
    return { setAutonomyMode() {}, abort() { release?.(); }, async run() { runs++; await new Promise(resolve => { release = resolve; }); } };
  });
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push((await newSession(h, i + 1)).result.sessionId);
  const prompt = (id, sessionId) => h.send({ jsonrpc: '2.0', id, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'work' }] } });
  const pending = ids.slice(0, 4).flatMap((sessionId, group) => Array.from({ length: 32 }, (_, i) => prompt(10 + group * 32 + i, sessionId)));
  try {
    await prompt(200, ids[4]);
    assert.equal((await h.waitFor(message => message.id === 200)).error.code, -32602);
    assert.equal(h.server.pendingPrompts, 128);
  } finally {
    for (const sessionId of ids) await h.send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } });
    await Promise.all(pending);
    await h.server.stop();
  }
  assert.equal(runs, 4);
  assert.equal(h.server.pendingPrompts, 0);
});

test("queue accounting returns to zero after a successful turn", async () => {
  const h = makeHarness(() => ({ setAutonomyMode() {}, abort() {}, async run() {} }));
  const sessionId = (await newSession(h)).result.sessionId;
  await h.send({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'work' }] } });
  assert.equal(h.server.sessions.get(sessionId).pendingPrompts, 0);
  assert.equal(h.server.pendingPrompts, 0);
});

test("queue accounting returns to zero after an agent constructor failure", async () => {
  const h = makeHarness(() => { throw new Error('initialization failed'); });
  const sessionId = (await newSession(h)).result.sessionId;
  await h.send({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'work' }] } });
  assert.equal(h.server.sessions.get(sessionId).pendingPrompts, 0);
  assert.equal(h.server.pendingPrompts, 0);
});

test("decision requests from a retired loop cannot ask for user permission", async () => {
  let retired;
  const h = makeHarness(() => ({
    setAutonomyMode() {}, abort() {}, async run() { retired = this; }
  }));
  const sessionId = (await newSession(h)).result.sessionId;
  await h.send({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'work' }] } });
  assert.equal(await retired.waitForDecision({ options: [{ id: 'a', label: 'A' }] }), null);
  assert.equal(h.find(message => message.method === 'session/request_permission').length, 0);
});

test("duplicate decision option IDs cannot produce an ambiguous approval request", async () => {
  let decision = 'unset';
  const h = makeHarness(() => ({
    setAutonomyMode() {}, abort() {},
    async run() { decision = await this.waitForDecision({ options: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] }); }
  }));
  const sessionId = (await newSession(h)).result.sessionId;
  await h.send({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'work' }] } });
  assert.equal(decision, null);
  assert.equal(h.find(message => message.method === 'session/request_permission').length, 0);
});

test("turn completion rejects an outstanding decision and clears its timer", async () => {
  let decision;
  const h = makeHarness(() => ({
    setAutonomyMode() {}, abort() {},
    async run() { decision = this.waitForDecision({ options: [{ id: 'a', label: 'A' }] }); }
  }));
  const sessionId = (await newSession(h)).result.sessionId;
  await h.send({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'work' }] } });
  assert.equal(h.server.pending.size, 0);
  assert.equal(await decision, null);
});

test("valid active-loop decisions still resolve through the peer protocol", async () => {
  let decision;
  const h = makeHarness(() => ({
    setAutonomyMode() {}, abort() {},
    async run() { decision = await this.waitForDecision({ options: [{ id: 'a', label: 'A' }] }); }
  }));
  const sessionId = (await newSession(h)).result.sessionId;
  const running = h.send({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text: 'work' }] } });
  const request = await h.waitFor(message => message.method === 'session/request_permission');
  await h.send({ jsonrpc: '2.0', id: request.id, result: { outcome: { outcome: 'selected', optionId: 'a' } } });
  await running;
  assert.deepEqual(decision, { optionId: 'a', label: 'A' });
  assert.equal(h.server.pending.size, 0);
});
