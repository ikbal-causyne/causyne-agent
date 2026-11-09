import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForAbortableDelay } from '../src/agent/abortableDelay.js';
import { repairUnansweredToolCalls } from '../src/agent/toolTurnIntegrity.js';
import { dispatchToolCall } from '../src/tools/toolDispatch.js';

const call = (id, name = 'fs_read') => ({ id, type: 'function', function: { name, arguments: '{}' } });
const tool = (id, content = '{}') => ({ role: 'tool', tool_call_id: id, name: 'fs_read', content });

test('repair unfinished multi-tool batch without replaying operations', () => {
  const before = [
    { role: 'user', content: 'check two files' },
    { role: 'assistant', content: '', tool_calls: [call('one'), call('two', 'fs_write')] },
    tool('one', '{"success":true,"output":"a"}'),
    { role: 'system', content: 'one result complete' },
    { role: 'assistant', content: 'Continuing.' }
  ];
  const result = repairUnansweredToolCalls(before);
  assert.deepEqual(result, { repaired: 1, affectedTurns: 1, unresolved: 0 });
  const inserted = before.find(m => m.role === 'tool' && m.tool_call_id === 'two');
  assert.ok(inserted);
  assert.deepEqual(JSON.parse(inserted.content).success, false);
  assert.match(inserted.content, /may or may not have executed/);
  assert.equal(before[2].content, '{"success":true,"output":"a"}');
  assert.deepEqual(repairUnansweredToolCalls(before), { repaired: 0, affectedTurns: 0, unresolved: 0 });
});

test('embedded image user message inside a tool batch does not cause false synthetic failures', () => {
  const history = [
    { role: 'assistant', tool_calls: [call('a', 'view_image'), call('b')] },
    tool('a'),
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,x' } }] },
    tool('b'),
    { role: 'assistant', content: 'finished' }
  ];
  assert.equal(repairUnansweredToolCalls(history).repaired, 0);
  assert.equal(history.length, 5);
});

test('missing result is inserted before next assistant and before user follow-up', () => {
  const history = [
    { role: 'assistant', tool_calls: [call('a')] },
    { role: 'user', content: 'next prompt' },
    { role: 'assistant', content: 'answer' }
  ];
  assert.equal(repairUnansweredToolCalls(history).repaired, 1);
  assert.equal(history[1].role, 'tool');
  assert.equal(history[2].role, 'user');
});

test('ambiguous duplicate IDs or missing IDs require an explicit stop rather than silent renumbering', () => {
  const dup = [{ role: 'assistant', tool_calls: [call('duplicate'), call('duplicate')] }];
  const repaired = repairUnansweredToolCalls(dup);
  assert.equal(repaired.unresolved, 1);
  const invalid = [{ role: 'assistant', tool_calls: [{ function: { name: 'fs_read' } }] }];
  assert.equal(repairUnansweredToolCalls(invalid).unresolved, 1);
});

test('backoff supports immediate abort and removes listeners on completed waits', async () => {
  const controller = new AbortController();
  let adds = 0; let removes = 0;
  const originalAdd = controller.signal.addEventListener.bind(controller.signal);
  const originalRemove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = (...args) => { adds++; return originalAdd(...args); };
  controller.signal.removeEventListener = (...args) => { removes++; return originalRemove(...args); };
  for (let i = 0; i < 25; i++) assert.equal(await waitForAbortableDelay(1, controller.signal), 'elapsed');
  assert.equal(adds, removes);
  const pending = waitForAbortableDelay(3000, controller.signal);
  controller.abort();
  assert.equal(await pending, 'aborted');
  assert.equal(adds, removes);
  assert.equal(await waitForAbortableDelay(100, controller.signal), 'aborted');
});

test('asynchronous authorization denial is awaited; execute never starts', async () => {
  let executed = 0;
  const result = await dispatchToolCall({
    toolCallId: 'deny', name: 'sysRun',
    authorize: async () => { await new Promise(resolve => setTimeout(resolve, 2)); return { allow: false, reason: 'requires approval' }; },
    execute: async () => { executed++; return { success: true }; }
  });
  assert.equal(executed, 0);
  assert.equal(result.denied, true);
  assert.equal(result.isError, true);
  assert.match(result.message.content, /requires approval/);
});

test('authorization exceptions fail closed, before any effect', async () => {
  let called = false;
  const result = await dispatchToolCall({
    toolCallId: 'auth-error', name: 'fs_write',
    authorize: async () => { throw new Error('policy service offline'); },
    execute: () => { called = true; return { success: true }; }
  });
  assert.equal(called, false);
  assert.equal(result.isError, true);
  assert.equal(result.denied, true);
});

test('failed tool payload and post-hook failure set isError even without a thrown tool exception', async () => {
  const bad = await dispatchToolCall({ toolCallId: 'bad', name: 'test', execute: () => ({ success: false, error: 'exit code 1' }) });
  assert.equal(bad.isError, true);
  const denied = await dispatchToolCall({ toolCallId: 'post', name: 'fs_write', execute: () => ({ success: true }), postHook: async () => { throw Error('post check failed'); } });
  assert.equal(denied.isError, true);
  assert.equal(JSON.parse(denied.message.content).success, false);
  assert.match(denied.message.content, /actual side effects/);
});

test('existing successful dispatch contract remains compatible', async () => {
  const result = await dispatchToolCall({ toolCallId: 'ok', name: 'fs_read', authorize: () => ({ allow: true }), execute: () => ({ success: true, output: 'x' }) });
  assert.deepEqual(Object.keys(result.message).sort(), ['content', 'name', 'role', 'tool_call_id']);
  assert.equal(result.isError, false);
  assert.equal(JSON.parse(result.message.content).output, 'x');
});

test('non-Error thrown values become stable errors without losing partial-usage metadata', async () => {
  const { normalizeAgentFailure } = await import('../src/agent/providerFailure.js');
  assert.equal(normalizeAgentFailure('network down').message, 'network down');
  assert.equal(normalizeAgentFailure(null).message, 'Unknown provider error');
  const partialUsage = { promptTokens: 10, completionTokens: 2 };
  const e = normalizeAgentFailure({ message: 42, code: 'PROVIDER_TOKEN_BUDGET', partialUsage });
  assert.match(e.message, /\[object Object\]/);
  assert.equal(e.code, 'PROVIDER_TOKEN_BUDGET');
  assert.strictEqual(e.partialUsage, partialUsage);
  const original = Error('same instance');
  assert.strictEqual(normalizeAgentFailure(original), original);
});

test('physical workspace boundary rejects out-of-scope symlinks and accepts new in-scope files', async () => {
  const { isPhysicalPathAllowed } = await import('../src/agent/workspaceBoundary.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-workspace-test-'));
  try {
    const workspace = path.join(parent, 'workspace');
    const outside = path.join(parent, 'outside');
    fs.mkdirSync(workspace); fs.mkdirSync(outside);
    fs.mkdirSync(path.join(workspace, 'subdir'));
    fs.symlinkSync(outside, path.join(workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    fs.symlinkSync(path.join(workspace, 'subdir'), path.join(workspace, 'safe'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(isPhysicalPathAllowed(path.join(workspace, 'subdir', 'new', 'file.ts'), [workspace]), true);
    assert.equal(isPhysicalPathAllowed(path.join(workspace, 'safe', 'file.ts'), [workspace]), true);
    assert.equal(isPhysicalPathAllowed(path.join(workspace, 'escape', 'secret.txt'), [workspace]), false);
    assert.equal(isPhysicalPathAllowed(path.join(workspace, 'escape', 'secret.txt'), [workspace], true), true);
    // The dangling link itself exists; lstat must not let it masquerade as a new file.
    fs.symlinkSync(path.join(outside, 'does-not-exist'), path.join(workspace, 'dangling'), 'file');
    assert.equal(isPhysicalPathAllowed(path.join(workspace, 'dangling'), [workspace]), false);
    assert.equal(isPhysicalPathAllowed(path.join(workspace, 'dangling', 'child'), [workspace]), false);
    assert.equal(isPhysicalPathAllowed(path.join(parent, 'workspace-copy'), [workspace]), false);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test('invalid or duplicate tool-call IDs are rejected before prefetch and dispatch', async () => {
  const { validateToolCallBatch } = await import('../src/agent/toolTurnIntegrity.js');
  assert.equal(validateToolCallBatch([call('one'), call('two')]).valid, true);
  assert.equal(validateToolCallBatch([call('dup'), call('dup')]).valid, false);
  assert.equal(validateToolCallBatch([{ function: { name: 'fs_read' } }]).valid, false);
  assert.equal(validateToolCallBatch([{ id: 'x', function: {} }]).valid, false);
  assert.equal(validateToolCallBatch({ id: 'bad' }).valid, false);
});

test('grant-all-access does not reclassify OS-protected symlink targets as safe', async (t) => {
  if (process.platform === 'win32') return t.skip('Unix-only protected path fixture');
  const { isPhysicalPathAllowed } = await import('../src/agent/workspaceBoundary.js');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-protected-link-'));
  try {
    fs.symlinkSync('/etc', path.join(workspace, 'protected'), 'dir');
    assert.equal(isPhysicalPathAllowed(path.join(workspace, 'protected', 'passwd'), [workspace]), false);
    assert.equal(isPhysicalPathAllowed(path.join(workspace, 'protected', 'passwd'), [workspace], true), false);
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});
