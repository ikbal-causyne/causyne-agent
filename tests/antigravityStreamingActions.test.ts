import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AntigravityProvider } from '../src/providers/antigravity.js';
import { AgentLoop } from '../src/agentLoop.js';

test('Antigravity streams tool start and completed actions in real time', { skip: process.platform === 'win32' }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-agy-stream-'));
  const command = path.join(directory, 'agy');
  fs.writeFileSync(command, `#!/usr/bin/env node
const emit = event => process.stdout.write(JSON.stringify(event) + '\\n');
process.stdin.resume();
process.stdin.on('end', () => {
  emit({ event: 'init', conversation_id: 'stream-test' });
  emit({ event: 'step_update', step_update: { step_index: 1, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'head -n 50 main.js' } } } });
  emit({ event: 'step_update', step_update: { step_index: 1, state: 'DONE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'head -n 50 main.js' } } } });
  emit({ event: 'result', result: { status: 'SUCCESS', conversation_id: 'stream-test', response: 'Completed inspection.', usage: { input_tokens: 10, output_tokens: 5 } } });
});
`, { mode: 0o755 });

  try {
    const provider = new AntigravityProvider({ command, model: 'Gemini 3.8 Flash (Low)' });
    const streamedActions: Array<{ name: string; status: string; detail?: string }> = [];

    const response = await provider.chat([{ role: 'user', content: 'check main.js' }], {
      onNativeAction: action => streamedActions.push({ name: action.name, status: action.status, detail: action.detail })
    });

    assert.equal(response.content, 'Completed inspection.');
    assert.deepEqual(streamedActions, [
      { name: 'run_command', status: 'running', detail: 'head -n 50 main.js' },
      { name: 'run_command', status: 'completed', detail: 'head -n 50 main.js' }
    ]);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('AgentLoop clears Acting status and emits notice when provider action completes', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-loop-status-'));
  const events: any[] = [];
  const ws = {
    readyState: 1,
    send: (raw: string) => {
      try { events.push(JSON.parse(raw)); } catch {}
    }
  };

  try {
    const loop = new AgentLoop(ws as any, 'task-status-test', 'inspect index.html', {
      workspaceRoot: directory
    });
    loop.config.provider = 'antigravity';
    loop.config.autonomyMode = 'C';

    (loop as any).initializeProvider = () => ({
      supportsVision: false,
      chat: async (_messages: any[], options: any) => {
        options.onNativeAction({ name: 'run_command', status: 'running', detail: 'head -n 50 index.html' });
        options.onNativeAction({ name: 'run_command', status: 'completed', detail: 'head -n 50 index.html' });
        return { content: 'Verified code.', toolCalls: [], usage: { promptTokens: 10, completionTokens: 5 } };
      }
    });

    await loop.run();

    const actingEvents = events.filter(e => e.type === 'status' && typeof e.message === 'string' && e.message.startsWith('Acting:'));
    assert.equal(actingEvents.length >= 1, true);
    assert.equal(actingEvents[0].message, 'Acting: run_command head -n 50 index.html');

    const statusClears = events.filter(e => e.type === 'status' && e.message === '');
    assert.equal(statusClears.length >= actingEvents.length, true, 'Every Acting status must be cleared on completion');

    const noticeEvents = events.filter(e => e.type === 'notice' && e.nativeStep === true);
    assert.equal(noticeEvents.length >= 1, true);
    assert.match(noticeEvents[0].message, /run_command head -n 50 index\.html/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('AgentLoop seeds Plan and retains it across subsequent runs', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-loop-plan-'));
  const planEvents: any[] = [];
  const ws = {
    readyState: 1,
    send: (raw: string) => {
      try {
        const parsed = JSON.parse(raw);
        if (parsed.type === 'agent_plan') planEvents.push(parsed);
      } catch {}
    }
  };

  try {
    const loop = new AgentLoop(ws as any, 'task-plan-test', 'build a 3d horse simulator in three.js', {
      workspaceRoot: directory
    });
    loop.config.provider = 'antigravity';
    loop.config.autonomyMode = 'C';

    (loop as any).initializeProvider = () => ({
      supportsVision: false,
      chat: async () => ({ content: 'Step 1 complete.', toolCalls: [], usage: { promptTokens: 10, completionTokens: 5 } })
    });

    await loop.run();
    assert.equal(planEvents.length >= 1, true, 'Initial run must emit agent_plan');
    assert.equal(planEvents[0].plan.length >= 3, true);

    const initialPlanLength = planEvents.length;
    // Set follow up prompt and run again
    loop.currentTaskPrompt = 'continue';
    await loop.run();
    assert.equal(planEvents.length > initialPlanLength, true, 'Subsequent run must re-emit agent_plan so sidebar is never blank');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
