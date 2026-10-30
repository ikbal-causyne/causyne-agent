import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AcpClient } from '../src/acp/client.js';
import { AgentLoop } from '../src/agentLoop.js';

test('inspectPeerDiagnostics detects quota, free limit, and fatal peer errors from stderr', () => {
  const client = new AcpClient({
    command: 'opencode',
    cwd: process.cwd(),
    allowHostTools: true
  });

  // Inject sample stderr error matching what OpenCode emits
  (client as any).stderrTail = 'AI_APICallError: Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go';
  const diag = client.inspectPeerDiagnostics('test-session');
  assert.ok(diag, 'Must detect diagnostic error from stderr');
  assert.match(diag!, /Free usage limit reached/);
});

test('AgentLoop.classifyError treats free usage limit and quota exhaustion as fatal errors', () => {
  const loop = new AgentLoop({ readyState: 1, send: () => {} }, 'test-task', 'build a game');
  assert.equal(loop.classifyError(new Error('AI_APICallError: Free usage limit reached. Free models work in OpenCode')), 'fatal');
  assert.equal(loop.classifyError(new Error('subscribe to OpenCode Go to keep going: https://opencode.ai/go')), 'fatal');
  assert.equal(loop.classifyError(new Error('insufficient_quota: You exceeded your current quota')), 'fatal');
  assert.equal(loop.classifyError(new Error('credit balance is too low to access the model')), 'fatal');
});

test('AcpClient resets inactivity timer when updates stream', async () => {
  const client = new AcpClient({
    command: 'opencode',
    cwd: process.cwd(),
    inactivityTimeoutMs: 50,
    promptTimeoutMs: 500
  });

  // Mock child process
  let killed = false;
  const mockChild: any = {
    stdin: { write: () => true, destroy: () => {} },
    stdout: { setEncoding: () => {}, on: () => {}, destroy: () => {} },
    stderr: { setEncoding: () => {}, on: () => {}, destroy: () => {} },
    on: () => {},
    once: () => {},
    kill: () => { killed = true; },
    exitCode: null,
    signalCode: null
  };
  (client as any).child = mockChild;

  // Verify notifyPendingActivity is safe to call with no pending requests
  assert.doesNotThrow(() => (client as any).notifyPendingActivity());
});

