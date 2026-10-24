import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TimeMachine } from '../src/timeMachine.js';
import type { ToolOutcome } from '../src/observer/evidence.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentLoop } from '../src/agentLoop.js';
import { toolRegistry } from '../src/tools/registry.js';

const priorSuccess: ToolOutcome = {
  tool: 'fs_read', args: {}, success: true, error: '', exitCode: null,
  command: '', path: '', at: 1
};

test('TimeMachine changes approach at three failed checks and stops at six', () => {
  const machine = new TimeMachine();
  const args = { command: 'npm test' };
  const stages = [];
  for (let attempt = 1; attempt <= 6; attempt++) {
    const decision = machine.observe('exec', args, {
      success: false, error: `test failed at line ${attempt}`, exitCode: 1
    }, [priorSuccess]);
    stages.push(decision.kind);
    assert.equal(decision.attempt, attempt);
    assert.equal(decision.lastGoodTool, 'fs_read');
  }
  assert.deepEqual(stages, ['continue', 'continue', 'replan', 'replan', 'replan', 'stop']);
});

test('only a successful matching check resolves its failure', () => {
  const machine = new TimeMachine();
  const check = { command: 'npm run typecheck:strict' };
  machine.observe('exec', check, { success: false, error: 'exit code 1' });
  assert.equal(machine.observe('fs_write', { path: 'file.ts' }, { success: true }).kind, 'none');
  assert.equal(machine.observe('exec', check, { success: true, exitCode: 0 }).kind, 'resolved');
  assert.equal(machine.observe('exec', check, { success: true }).kind, 'none');
});

test('permission failures ask for human action immediately and task reset clears attempts', () => {
  const machine = new TimeMachine();
  const args = { command: 'npm publish' };
  const blocked = machine.observe('exec', args, { success: false, error: 'Permission denied' });
  assert.equal(blocked.kind, 'human');
  assert.equal(blocked.attempt, 1);
  machine.reset();
  assert.equal(machine.observe('exec', args, { success: false, error: 'exit code 1' }).attempt, 1);
});

test('distinct checks have separate budgets without retaining raw error text', () => {
  const machine = new TimeMachine();
  assert.equal(machine.observe('exec', { command: 'npm test' }, { success: false, error: 'secret.example test failed' }).attempt, 1);
  const second = machine.observe('exec', { command: 'npm run build' }, { success: false, error: 'exit code 1' });
  assert.equal(second.attempt, 1);
  assert.equal(JSON.stringify(second).includes('secret.example'), false);
});

test('agent loop stops a repeatedly failing returned tool result after six executions', async () => {
  const previousDirectory = process.cwd();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-time-machine-'));
  fs.writeFileSync(path.join(workspace, 'package.json'), '{}');
  process.chdir(workspace);
  const toolName = 'time_machine_probe';
  let executions = 0;
  const events: Array<{ type: string; message?: string }> = [];
  toolRegistry[toolName] = {
    schema: { name: toolName, description: 'Test probe', parameters: { type: 'object', properties: {} } },
    execute: async () => { executions += 1; return { success: false, error: 'exit code 1' }; }
  };

  try {
    const loop = new AgentLoop({ readyState: 1, send: (payload: string) => events.push(JSON.parse(payload)) },
      'time-machine-regression', 'inspect a failing check');
    const model = {
      supportsVision: false,
      supportsToolSearch: () => false,
      chat: async () => ({ content: '',
        toolCalls: [{ id: `probe-${executions}`, type: 'function',
          function: { name: toolName, arguments: '{}' } }],
        usage: { promptTokens: 10, completionTokens: 8 } })
    };
    loop.initializeProvider = () => model as never;

    await loop.run();

    assert.equal(executions, 6);
    assert.equal(events.some((event) => event.type === 'error' && event.message?.includes('6 attempts')), true);
    assert.equal(events.some((event) => event.type === 'status' && event.message === 'Task completed.'), false);
    assert.equal(events.some((event) => event.type === 'task_complete'), false);
  } finally {
    delete toolRegistry[toolName];
    process.chdir(previousDirectory);
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
