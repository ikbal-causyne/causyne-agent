import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentLoop } from '../src/agentLoop.js';
import { resolveTool } from '../src/tools/registry.js';

test('agent loop preserves partial browser work as a failed tool result, never verification', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'causyne-agent-browser-recovery-'));
  const oldCwd = process.cwd();
  const browserTool = resolveTool('browser_act');
  assert.ok(browserTool);
  const originalExecute = browserTool.execute;
  const events = [];
  let executed = 0;
  browserTool.execute = async () => {
    executed++;
    return {
      success: false,
      code: 'BROWSER_BATCH_PARTIAL_FAILURE',
      error: 'Browser action 2 (click) failed: target detached',
      failedActionIndex: 1,
      failedActionType: 'click',
      completedActions: [{ action: 'goto', url: 'https://example.org/app' }],
      retryGuidance: 'Do not repeat the completed browser actions.'
    };
  };
  process.chdir(root);
  try {
    const loop = new AgentLoop(
      { readyState: 1, send(payload) { events.push(JSON.parse(payload)); } },
      'browser-batch-agent-loop', 'Inspect the website.',
      { workspaceRoot: root, autoApprove: true }
    );
    let turns = 0;
    loop.initializeProvider = () => ({
      supportsVision: false,
      supportsToolSearch: () => false,
      chat: async () => {
        turns++;
        if (turns === 1) return {
          content: '',
          toolCalls: [{
            id: 'browser-1', type: 'function',
            function: { name: 'browser_act', arguments: JSON.stringify({
              actions: [{ type: 'goto', url: 'https://example.org/app' },
                { type: 'click', selector: '#purchase' }]
            }) }
          }],
          usage: { promptTokens: 2, completionTokens: 2 }
        };
        loop.abort();
        return { content: '', usage: { promptTokens: 1, completionTokens: 1 } };
      }
    });
    await loop.run();
    assert.equal(executed, 1, 'agent must dispatch browser tool exactly once');
    const observation = loop.messages.find(m => m.role === 'tool' && m.name === 'browser_act');
    assert.ok(observation, 'failure must be returned to the model');
    const parsed = JSON.parse(String(observation.content));
    assert.equal(parsed.success, false);
    assert.equal(parsed.completedActions?.[0]?.action, 'goto');
    assert.equal(parsed.failedActionIndex, 1);
    assert.equal(loop.webVerificationState.browserActUsed, false);
    assert.equal(events.some(e => e.type === 'step_complete' && e.tool === 'browser_act'), false);
  } finally {
    browserTool.execute = originalExecute;
    process.chdir(oldCwd);
    await fs.rm(root, { recursive: true, force: true });
  }
});
