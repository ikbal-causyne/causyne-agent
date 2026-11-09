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
