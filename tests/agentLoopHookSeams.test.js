// The PreToolUse/PostToolUse seams in agentLoop.js.
//
// Hooks are optional. These tests pin the compatibility contract: a loop with
// no configured hooks allows, even when the method is exercised without a full
// AgentLoop instance, while configured behaviour is covered in hooks.test.js.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop } from '../src/agentLoop.js';

describe('hook seams default to allow when no hooks are configured', () => {
  test('runPreToolUse allows by default', async () => {
    const r = await AgentLoop.prototype.runPreToolUse.call({}, 'fs_read', {}, 'id');
    assert.deepEqual(r, { denied: false, messages: [] });
  });

  test('runPostToolUse allows by default', async () => {
    const r = await AgentLoop.prototype.runPostToolUse.call({}, 'fs_read', {}, { success: true });
    assert.deepEqual(r, { denied: false, messages: [] });
  });

  test('the seams are async and never throw', async () => {
    await assert.doesNotReject(AgentLoop.prototype.runPreToolUse.call({}, 'x', {}, 'i'));
    await assert.doesNotReject(AgentLoop.prototype.runPostToolUse.call({}, 'x', {}, {}));
  });
});
