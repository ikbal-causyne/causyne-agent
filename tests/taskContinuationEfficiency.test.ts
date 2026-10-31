import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentLoop } from '../src/agentLoop.js';
import { EfficiencyCheckpoint } from '../src/providers/budgetEnforcer.js';

test('AgentLoop does not abort on turn efficiency checkpoint: compacts and completes task', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-efficiency-continuation-'));
  const events: any[] = [];
  const ws = {
    readyState: 1,
    send: (raw: string) => {
      try { events.push(JSON.parse(raw)); } catch {}
    }
  };

  let callCount = 0;

  try {
    const loop = new AgentLoop(ws as any, 'task-eff-cont', 'Create proof.txt containing READY', {
      workspaceRoot: workspace
    });
    loop.config.provider = 'antigravity';
    loop.config.autonomyMode = 'C';
    loop.autonomyOverride = 'C';

    (loop as any).initializeProvider = () => {
      loop.config.autonomyMode = 'C';
      loop.autonomyOverride = 'C';
      return {
        supportsVision: false,
        supportsToolSearch: () => false,
        chat: async () => {
          callCount++;
          if (callCount === 1) {
            // Simulate first turn hitting single-turn limit after native actions
            throw new EfficiencyCheckpoint('tokens', 392_822, 250_000, 'turn');
          }
          if (callCount === 2) {
            return {
              content: '',
              toolCalls: [{
                id: 'write-proof',
                type: 'function',
                function: {
                  name: 'fs_write',
                  arguments: JSON.stringify({ path: path.join(workspace, 'proof.txt'), content: 'READY' })
                }
              }],
              usage: { promptTokens: 50, completionTokens: 25 }
            };
          }
          return {
            content: 'Created proof.txt.',
            usage: { promptTokens: 30, completionTokens: 20 }
          };
        }
      };
    };

    await loop.run();

    // Verify it continued past the efficiency checkpoint
    assert.equal(callCount, 3, 'Expected exactly 3 turns');
    assert.ok(events.some(e => e.type === 'budget_warning'), 'Expected budget warning emitted');
    assert.ok(events.some(e => e.type === 'status' && e.message?.includes('efficiency checkpoint')), 'Expected status notice emitted');
    assert.equal(events.some(e => e.type === 'task_complete'), true, 'Expected task to complete successfully');
    assert.ok(fs.existsSync(path.join(workspace, 'proof.txt')), 'Deliverable must exist on disk');
    assert.equal(fs.readFileSync(path.join(workspace, 'proof.txt'), 'utf8'), 'READY');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});


