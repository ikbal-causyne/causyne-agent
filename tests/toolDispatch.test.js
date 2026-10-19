// The tool-dispatch discipline (claw-code conversation.rs:201-254).
//
// The invariant under test: a denial or a failure is NEVER thrown — it comes back
// as a tool_result with an error flag so the model self-corrects. Before this
// module there was no test for the agent's tool handling at all.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { dispatchToolCall, mergeHookFeedback, toolResultMessage } from '../src/tools/toolDispatch.js';

const payloadOf = (message) => JSON.parse(message.content);

describe('dispatchToolCall — deny/execute/throw all become tool results', () => {
  test('a permitted tool executes and returns its payload', async () => {
    const r = await dispatchToolCall({
      toolCallId: 'c1', name: 'fs_read', args: { path: '/x' },
      authorize: () => ({ allow: true }),
      execute: async () => ({ success: true, output: 'file body' })
    });
    assert.equal(r.isError, false);
    assert.equal(r.denied, false);
    assert.equal(r.message.role, 'tool');
    assert.equal(r.message.tool_call_id, 'c1');
    assert.equal(payloadOf(r.message).output, 'file body');
  });

  test('a denied permission returns an is_error result, not a throw', async () => {
    const r = await dispatchToolCall({
      toolCallId: 'c2', name: 'sysRun', args: { command: 'rm -rf /' },
      authorize: () => ({ allow: false, reason: 'blocked by policy' }),
      execute: async () => { throw new Error('should never run'); }
    });
    assert.equal(r.denied, true);
    assert.equal(r.isError, true);
    assert.equal(payloadOf(r.message).success, false);
    assert.match(payloadOf(r.message).error, /blocked by policy/);
  });

  test('a thrown execute is recovered into an is_error result', async () => {
    const r = await dispatchToolCall({
      toolCallId: 'c3', name: 'fs_write', args: {},
      execute: async () => { throw new Error('ENOENT: no such file'); }
    });
    assert.equal(r.isError, true);
    assert.equal(r.denied, false);          // an execute failure is not a denial
    assert.equal(payloadOf(r.message).success, false);
    assert.match(payloadOf(r.message).error, /ENOENT/);
  });

  test('dispatch itself never throws for a tool-level failure', async () => {
    await assert.doesNotReject(dispatchToolCall({
      toolCallId: 'c4', name: 'x',
      execute: async () => { throw new Error('boom'); }
    }));
  });
});

describe('dispatchToolCall — hooks', () => {
  test('a PreToolUse denial short-circuits before execute', async () => {
    let ran = false;
    const r = await dispatchToolCall({
      toolCallId: 'h1', name: 'sysRun', args: { command: 'curl evil' },
      preHook: () => ({ denied: true, messages: ['network egress refused'] }),
      execute: async () => { ran = true; return { success: true }; }
    });
    assert.equal(ran, false, 'execute must not run after a pre-hook denial');
    assert.equal(r.isError, true);
    assert.match(payloadOf(r.message).error, /PreToolUse hook denied/);
    assert.match(payloadOf(r.message).hookFeedback, /network egress refused/);
  });

  test('a PostToolUse denial flips a success to an error', async () => {
    const r = await dispatchToolCall({
      toolCallId: 'h2', name: 'fs_write', args: { path: '/etc/x' },
      execute: async () => ({ success: true, output: 'wrote' }),
      postHook: () => ({ denied: true, messages: ['protected path touched'] })
    });
    assert.equal(r.isError, true);
    assert.equal(payloadOf(r.message).success, false);
    assert.match(payloadOf(r.message).hookFeedback, /protected path touched/);
  });

  test('pre-hook feedback rides along on a successful call', async () => {
    const r = await dispatchToolCall({
      toolCallId: 'h3', name: 'fs_read', args: {},
      preHook: () => ({ denied: false, messages: ['note: large file'] }),
      execute: async () => ({ success: true, output: 'ok' })
    });
    assert.equal(r.isError, false);
    assert.match(payloadOf(r.message).hookFeedback, /note: large file/);
  });

  test('no hooks configured = clean passthrough', async () => {
    const r = await dispatchToolCall({
      toolCallId: 'h4', name: 'fs_read', execute: async () => ({ success: true })
    });
    assert.equal(r.isError, false);
    assert.equal(payloadOf(r.message).hookFeedback, undefined);
  });
});

describe('helpers', () => {
  test('toolResultMessage has the provider shape', () => {
    const m = toolResultMessage('id', 'fs_read', { success: true });
    assert.deepEqual(Object.keys(m).sort(), ['content', 'name', 'role', 'tool_call_id']);
    assert.equal(m.role, 'tool');
  });

  test('mergeHookFeedback is a no-op with no messages', () => {
    const p = { success: true };
    assert.equal(mergeHookFeedback(p, []), p);
  });
});
