import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentLoop } from '../src/agentLoop.js';

test('malformed provider plan callbacks cannot crash or erase a valid plan', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-plan-malformed-'));
  try {
    const loop = new AgentLoop(null, 'plan-malformed', 'implement a small change', { workspaceRoot: workspace });
    loop.updateImplementationPlan({ explanation: 'initial', plan: [
      { id: 'verify', step: 'Verify behavior', status: 'in_progress' }
    ] }, { seeded: true });
    const original = JSON.stringify(loop._implementationPlan);
    for (const malformed of [null, undefined, {}, { plan: null }, { plan: 'not-an-array' }, { plan: 1 }]) {
      assert.doesNotThrow(() => loop.updateImplementationPlan(malformed));
      assert.equal(JSON.stringify(loop._implementationPlan), original);
    }
    // An explicit empty plan is different from an invalid plan: it may clear it.
    assert.doesNotThrow(() => loop.updateImplementationPlan({ plan: [] }, { seeded: true }));
    assert.deepEqual(loop._implementationPlan, []);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
