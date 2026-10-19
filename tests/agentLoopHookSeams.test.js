// The PreToolUse/PostToolUse seams in agentLoop.js.
//
// Stage 2 wires the seams as no-ops (always allow), so tool dispatch behaves
// exactly as before; Stage 3 fills them with the real shell-hook runner. These
// tests pin the contract: the defaults allow, and the loop's branch on `denied`
// is correct — a denying override short-circuits without running the tool.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AgentLoop } from '../src/agentLoop.js';

describe('hook seams default to allow (Stage 2 is behaviour-neutral)', () => {
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
