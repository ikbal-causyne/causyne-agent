/** Real-repository integration tests. Run after applying the AgentLoop patch. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentLoop } from '../src/agentLoop.js';
import { getProcessEntitlementGate } from '../src/licensing/entitlements.js';

function newLoop(): { loop: AgentLoop; cleanup: () => void; events: Array<Record<string, unknown>> } {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-loop-guard-'));
  const events: Array<Record<string, unknown>> = [];
  const loop = new AgentLoop({ readyState: 1, send: (value: string) => {
    events.push(JSON.parse(value) as Record<string, unknown>);
  } }, `loop-guard-${Date.now()}`, 'hello', { workspaceRoot: workspace });
  // Limit these tests to the outer lifecycle: no network calls or tool effects.
  loop.messages = [];
  loop.memoryManager = { saveHistory: () => {} };
  return { loop, cleanup: () => fs.rmSync(workspace, { recursive: true, force: true }), events };
}

// Both tests use the one process-wide licensing gate; do not run concurrently.
test('abort while waiting for entitlement never starts the inner agent loop', { concurrency: false }, async () => {
  const gate = getProcessEntitlementGate();
  const originalBegin = gate.begin;
  const originalEnd = gate.end;
  let finishBegin: (() => void) | undefined;
  let executions = 0;
  let ended = 0;
  const { loop, cleanup } = newLoop();
  try {
    gate.begin = async () => new Promise<void>((resolve) => { finishBegin = resolve; });
    gate.end = () => { ended++; };
    loop.runLicensedCore = async () => { executions++; };
    const running = loop.run();
    assert.ok(finishBegin);
    loop.abort();
    finishBegin?.();
    await running;
    assert.equal(executions, 0, 'cancelled run must not enter runLicensedCore');
    assert.equal(ended, 1, 'licensing gate must still be closed');
  } finally {
    gate.begin = originalBegin;
    gate.end = originalEnd;
    cleanup();
  }
});

test('two run() invocations cannot execute one AgentLoop concurrently', { concurrency: false }, async () => {
  const gate = getProcessEntitlementGate();
  const originalBegin = gate.begin;
  const originalEnd = gate.end;
  const { loop, cleanup, events } = newLoop();
  let unlock: (() => void) | undefined;
  let runs = 0;
  try {
    gate.begin = async () => {};
    gate.end = () => {};
    loop.runLicensedCore = async () => {
      runs++;
      await new Promise<void>((resolve) => { unlock = resolve; });
    };
    const running = loop.run();
    await Promise.resolve();
    await loop.run();
    assert.equal(runs, 1);
    assert.ok(events.some(event => event.type === 'error' && /already running/i.test(String(event.message))));
    unlock?.();
    await running;
    assert.equal(loop._runActive, false);
  } finally {
    gate.begin = originalBegin;
    gate.end = originalEnd;
    unlock?.();
    cleanup();
  }
});

test('run() repairs interrupted multi-tool history and never claims it executed', { concurrency: false }, async () => {
  const gate = getProcessEntitlementGate();
  const originalBegin = gate.begin;
  const originalEnd = gate.end;
  const { loop, cleanup } = newLoop();
  let saves = 0;
  try {
    gate.begin = async () => {};
    gate.end = () => {};
    loop.messages = [{ role: 'assistant', content: '', tool_calls: [
      { id: 'completed', function: { name: 'fs_read', arguments: '{}' } },
      { id: 'missing', function: { name: 'fs_write', arguments: '{}' } }
    ] }, { role: 'tool', tool_call_id: 'completed', name: 'fs_read', content: '{"success":true}' }];
    loop.memoryManager = { saveHistory: () => { saves++; } };
    loop.runLicensedCore = async () => {};
    await loop.run();
    assert.equal(loop.messages.filter((item: any) => item.tool_call_id === 'missing').length, 1);
    assert.match(loop.messages.find((item: any) => item.tool_call_id === 'missing')!.content, /TOOL_OUTCOME_UNRECORDED/);
    assert.equal(saves, 1);
  } finally {
    gate.begin = originalBegin;
    gate.end = originalEnd;
    cleanup();
  }
});

test('duplicate approval identifiers cannot replace an existing waiter', async () => {
  const { loop, cleanup } = newLoop();
  try {
    const first = loop.waitForApproval('same-id');
    assert.equal(await loop.waitForApproval('same-id'), false);
    loop.handleApprovalResponse('same-id', true);
    assert.equal(await first, true);
  } finally { loop.abort(); cleanup(); }
});

test('abort consumes a rejected asynchronous provider close', async () => {
  const { loop, cleanup } = newLoop();
  let closes = 0;
  try {
    loop.llm = { close: async () => { closes++; throw new Error('peer already closed'); } } as any;
    loop.abort();
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(closes, 1);
  } finally { cleanup(); }
});

test('peer permission without a tool-call identifier is cancelled before authorization', async () => {
  const { loop, cleanup } = newLoop();
  try {
    loop.authorizePeerOperation = async () => { assert.fail('unexpected authorization'); };
    const result = await loop.requestPeerPermission({ toolCall: { title: 'missing ID', kind: 'read' }, options: [{ optionId: 'allow', kind: 'allow_once', name: 'Allow' }] } as any);
    assert.deepEqual(result, { outcome: 'cancelled' });
  } finally { cleanup(); }
});

test('peer file read rejects overflowing line ranges before authorization', async () => {
  const { loop, cleanup } = newLoop();
  try {
    loop.authorizePeerOperation = async () => { assert.fail('unexpected authorization'); };
    await assert.rejects(loop.executePeerFile('fs_read', 'a.txt', undefined, { line: Number.MAX_SAFE_INTEGER, limit: 2 }), /safe integer/);
  } finally { cleanup(); }
});

test('peer file access revalidates a parent symlink changed during authorization', async () => {
  const { loop, cleanup } = newLoop();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-peer-outside-'));
  const root = loop.workspaceRoot;
  try {
    fs.mkdirSync(path.join(root, 'nested'));
    fs.writeFileSync(path.join(root, 'nested', 'a.txt'), 'allowed');
    fs.writeFileSync(path.join(outside, 'a.txt'), 'private');
    loop.authorizePeerOperation = async () => {
      fs.renameSync(path.join(root, 'nested'), path.join(root, 'old'));
      fs.symlinkSync(outside, path.join(root, 'nested'), process.platform === 'win32' ? 'junction' : 'dir');
      return true;
    };
    await assert.rejects(loop.executePeerFile('fs_read', 'nested/a.txt'), /not authorized/);
  } finally { cleanup(); fs.rmSync(outside, { recursive: true, force: true }); }
});

test('non-boolean approval payload cannot authorize a tool', async () => {
  const { loop, cleanup } = newLoop();
  try {
    const pending = loop.waitForApproval('strict-approval');
    loop.handleApprovalResponse('strict-approval', 'false' as any);
    assert.equal(await pending, false);
  } finally { loop.abort(); cleanup(); }
});
