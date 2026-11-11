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

test('TimeMachine changes approach at three failed checks and stops at six when extended', () => {
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
    if (decision.kind === 'consent') {
      machine.grantExtension(decision.issueKey);
    }
  }
  assert.deepEqual(stages, ['continue', 'continue', 'consent', 'replan', 'replan', 'stop']);
});

test('TimeMachine stops after consent if extension is not granted', () => {
  const machine = new TimeMachine();
  const args = { command: 'npm test' };
  const stages = [];
  for (let attempt = 1; attempt <= 4; attempt++) {
    const decision = machine.observe('exec', args, {
      success: false, error: `test failed at line ${attempt}`, exitCode: 1
    }, [priorSuccess]);
    stages.push(decision.kind);
  }
  assert.deepEqual(stages, ['continue', 'continue', 'consent', 'stop']);
});

test('only a successful matching check resolves its failure', () => {
  const machine = new TimeMachine();
  const check = { command: 'npm run typecheck:strict' };
  machine.observe('exec', check, { success: false, error: 'exit code 1' });
  assert.equal(machine.observe('fs_write', { path: 'file.ts' }, { success: true }).kind, 'none');
  assert.equal(machine.observe('exec', check, { success: true, exitCode: 0 }).kind, 'resolved');
  assert.equal(machine.observe('exec', check, { success: true }).kind, 'none');
});

test('a site refusal immediately redirects the agent away from the blocked URL', () => {
  const machine = new TimeMachine();
  const decision = machine.observe('web_fetch', { url: 'https://example.com/blocked' }, {
    success: false, status: 403, failureKind: 'site_refusal', error: 'HTTP 403'
  });
  assert.equal(decision.kind, 'replan');
  assert.equal(decision.attempt, 1);
  assert.match(decision.guidance, /another public source/);
  const alternative = machine.observe('web_fetch', { url: 'https://other.example.org/article' }, {
    success: false, status: 403, failureKind: 'site_refusal', error: 'HTTP 403'
  });
  assert.equal(alternative.attempt, 1);
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
    loop.waitForDecision = async () => ({ optionId: 'allow', label: 'Allow 3 more' } as any);
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

test('agent loop stops at three failed attempts when user declines retry consent', async () => {
  const previousDirectory = process.cwd();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-time-machine-decline-'));
  fs.writeFileSync(path.join(workspace, 'package.json'), '{}');
  process.chdir(workspace);
  const toolName = 'time_machine_decline_probe';
  let executions = 0;
  const events: Array<{ type: string; message?: string }> = [];
  toolRegistry[toolName] = {
    schema: { name: toolName, description: 'Test probe', parameters: { type: 'object', properties: {} } },
    execute: async () => { executions += 1; return { success: false, error: 'exit code 1' }; }
  };

  try {
    const loop = new AgentLoop({ readyState: 1, send: (payload: string) => events.push(JSON.parse(payload)) },
      'time-machine-decline', 'inspect a failing check');
    loop.waitForDecision = async () => ({ optionId: 'stop', label: 'Stop and report' } as any);
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

    assert.equal(executions, 3);
    assert.equal(events.some((event) => event.type === 'error' && event.message?.includes('3 times')), true);
    assert.equal(events.some((event) => event.type === 'status' && event.message === 'Task completed.'), false);
    assert.equal(events.some((event) => event.type === 'task_complete'), false);
  } finally {
    delete toolRegistry[toolName];
    process.chdir(previousDirectory);
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('empty error strings are not tool failures or false observer outcomes', async () => {
  const machine = new TimeMachine();
  const target = { command: 'npm test' };
  const first = machine.observe('exec', target, { success: true, error: '', exitCode: 0 });
  assert.equal(first.kind, 'none');
  assert.equal(first.attempt, 0);
  const failure = machine.observe('exec', target, { success: false, error: '' });
  assert.equal(failure.kind, 'continue');
  const recovery = machine.observe('exec', target, { success: true, error: '', exitCode: 0 });
  assert.equal(recovery.kind, 'resolved');
  const { outcomeFromResult } = await import('../src/observer/evidence.js');
  assert.equal(outcomeFromResult('exec', target, { success: true, error: '', exitCode: 0 }, 0).success, true);
  assert.equal(outcomeFromResult('exec', target, { success: false, error: '' }, 0).success, false);
});

test('a nonzero exit code cannot resolve TimeMachine history or pass evidence normalization', async () => {
  const machine = new TimeMachine();
  const args = { command: 'npm test' };
  assert.equal(machine.observe('exec', args, { success: false, exitCode: 1 }).attempt, 1);
  const stillFailed = machine.observe('exec', args, { success: true, error: '', exitCode: 2 });
  assert.equal(stillFailed.kind, 'continue');
  assert.equal(stillFailed.attempt, 2);
  assert.equal(machine.observe('exec', args, { success: true, exitCode: 0 }).kind, 'resolved');
  const { outcomeFromResult } = await import('../src/observer/evidence.js');
  assert.equal(outcomeFromResult('exec', args, { success: true, exitCode: 1 }, 0).success, false);
});

test('distinct endpoints and working directories have independent retry budgets', () => {
  const machine = new TimeMachine();
  const fail = { success: false, error: 'service unavailable' };
  const first = { endpoint: 'http://127.0.0.1:3000/health' };
  const second = { endpoint: 'http://127.0.0.1:3000/status' };
  assert.equal(machine.observe('verify_local_web', first, fail).attempt, 1);
  assert.equal(machine.observe('verify_local_web', second, fail).attempt, 1);
  assert.equal(machine.observe('verify_local_web', first, fail).attempt, 2);
  assert.equal(machine.observe('exec', { command: 'npm test', cwd: '/workspace/one' }, fail).attempt, 1);
  assert.equal(machine.observe('exec', { command: 'npm test', cwd: '/workspace/two' }, fail).attempt, 1);
  assert.equal(machine.observe('web_fetch', { url: 'https://example.org/a' }, fail).attempt, 1);
  assert.equal(machine.observe('web_fetch', { url: 'https://example.org/b' }, fail).attempt, 1);
});

test('lastGoodTool ignores outcomes with nonzero exit codes or error text', () => {
  const machine = new TimeMachine();
  const corruptExit = { ...priorSuccess, tool: 'failed_test', success: true, exitCode: 1, at: 2 };
  const corruptError = { ...priorSuccess, tool: 'failed_build', success: true, error: 'build failed', at: 3 };
  const decision = machine.observe('exec', { command: 'npm test' },
    { success: false, error: 'check failed' }, [priorSuccess, corruptExit, corruptError]);
  assert.equal(decision.lastGoodTool, 'fs_read');
  assert.match(decision.guidance, /Last successful tool: fs_read/);
});

test('failure attempts remain bounded after the six-attempt limit', () => {
  const machine = new TimeMachine();
  const args = { command: 'npm test' };
  const fail = { success: false, error: 'test failed' };
  for (let n = 1; n <= 9; n++) {
    const decision = machine.observe('exec', args, fail);
    assert.equal(decision.attempt, Math.min(n, 6));
    if (n === 3) machine.grantExtension(decision.issueKey);
    if (n >= 6) assert.equal(decision.kind, 'stop');
  }
});

test('alternate command argument names keep unrelated scripts in different retry families', () => {
  const machine = new TimeMachine();
  const fail = { success: false, error: 'exited with code 1' };
  assert.equal(machine.observe('exec', { CommandLine: 'npm run build' }, fail).attempt, 1);
  assert.equal(machine.observe('exec', { CommandLine: 'npm run typecheck' }, fail).attempt, 1);
  assert.equal(machine.observe('exec', { commandLine: 'npm run lint' }, fail).attempt, 1);
  assert.equal(machine.observe('exec', { script: 'npm run unit' }, fail).attempt, 1);
  assert.equal(machine.observe('exec', { CommandLine: 'npm run build' }, fail).attempt, 2);
});

test('explicit site refusal without an error string remains a failure and replans', () => {
  const machine = new TimeMachine();
  const decision = machine.observe('web_fetch', { url: 'https://example.org/blocked' }, {
    failureKind: 'site_refusal', status: 403, error: ''
  });
  assert.equal(decision.kind, 'replan');
  assert.equal(decision.attempt, 1);
  assert.match(decision.guidance, /another public source/);
});

test('rate limits demand backoff immediately while retaining the consent boundary', () => {
  const machine = new TimeMachine();
  const args = { command: 'npm publish' };
  const result = { success: false, error: 'HTTP 429 rate limit reached' };
  const first = machine.observe('exec', args, result);
  assert.equal(first.kind, 'replan');
  assert.match(first.guidance, /retry\/reset window/);
  assert.equal(machine.observe('exec', args, result).kind, 'replan');
  assert.equal(machine.observe('exec', args, result).kind, 'consent');
});
