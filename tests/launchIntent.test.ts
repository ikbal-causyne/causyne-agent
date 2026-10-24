import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isLaunchOnlyPrompt, isServerLaunchCommand, launchScopeError } from '../src/launchIntent.js';
import { AntigravityProvider } from '../src/providers/antigravity.js';
import { sysRun, sysRunBg } from '../src/tools/sysRun.js';
import { AgentLoop } from '../src/agentLoop.js';

test('opening an existing project excludes file mutation and unrelated commands', () => {
  assert.equal(isLaunchOnlyPrompt('open it'), true);
  assert.equal(isLaunchOnlyPrompt('buka project ini'), true);
  assert.equal(isLaunchOnlyPrompt('open it and edit server.py'), false);
  assert.equal(isLaunchOnlyPrompt('run tests'), false);
  assert.match(launchScopeError('fs_edit', { path: 'server.py' }), /not change/);
  assert.match(launchScopeError('sysRun', { command: 'python3 -c "open(\"server.py\",\"w\")"' }), /does not authorize/);
  assert.match(launchScopeError('sysRun', { command: 'ls -la && rm server.py' }), /chained shell commands/);
  assert.equal(launchScopeError('tool_search', {}), null);
  assert.equal(launchScopeError('update_plan', {}), null);
  assert.equal(launchScopeError('desktop_open', { target: '~/village_cat_foundation/index.html' }), null);
  assert.equal(launchScopeError('desktop.open', { target: 'http://localhost:8000' }), null);
  assert.equal(launchScopeError('sysRun', { command: 'open "http://localhost:8000/?test=1&debug=true"' }), null);
  assert.equal(launchScopeError('sysRun', { command: 'ls -la /tmp' }), null);
  assert.equal(launchScopeError('sysRun', { command: 'python3 /tmp/server.py' }), null);
  assert.equal(launchScopeError('sysRun', { command: 'curl -f http://127.0.0.1:8765/' }), null);
  assert.match(launchScopeError('sysRun', { command: 'curl -o server.py http://example.com/' }), /Use read-only inspection/);
  assert.equal(isServerLaunchCommand('python3 /tmp/server.py'), true);
});

test('resumed Antigravity launch turn uses plan mode and carries current scope', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-launch-agy-'));
  const agy = path.join(dir, 'agy');
  const log = path.join(dir, 'calls.jsonl');
  fs.writeFileSync(agy, `#!/usr/bin/env node
const fs = require('node:fs');
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const call = { args: process.argv.slice(2), cwd: process.cwd(), input: JSON.parse(input.trim()).message.content };
  fs.appendFileSync(process.env.CAUSYNE_LAUNCH_TEST_LOG, JSON.stringify(call) + '\\n');
  process.stdout.write(JSON.stringify({event:'init', conversation_id:'conv-1'}) + '\\n');
  process.stdout.write(JSON.stringify({event:'result', result:{status:'SUCCESS', conversation_id:'conv-1', response:'ok'}}) + '\\n');
});
`, { mode: 0o755 });
  process.env.CAUSYNE_LAUNCH_TEST_LOG = log;
  try {
    const provider = new AntigravityProvider({ command: agy });
    await provider.chat([{ role: 'user', content: 'Create project' }], { taskId: 'same-task', workspaceRoot: dir });
    await provider.chat([
      { role: 'user', content: 'Create project' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'open it' }
    ], { taskId: 'same-task', taskIntent: 'launch', workspaceRoot: dir });
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(calls[0].args[calls[0].args.indexOf('--mode') + 1], 'accept-edits');
    assert.equal(calls[1].args[calls[1].args.indexOf('--mode') + 1], 'plan');
    assert.equal(calls[1].args[calls[1].args.indexOf('--print-timeout') + 1], '90s');
    assert.equal(fs.realpathSync(calls[1].cwd), fs.realpathSync(dir));
    assert.match(calls[1].input, /Do not create, edit, delete/);
    assert.ok(calls[1].args.includes('--conversation'));
    assert.doesNotMatch(calls[0].input, /Pre-Verified Host Environment/);
  } finally {
    delete process.env.CAUSYNE_LAUNCH_TEST_LOG;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('launch-only sysRun does not wait for a foreground server', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-launch-server-'));
  const server = path.join(dir, 'server.py');
  fs.writeFileSync(server, 'import time\ntime.sleep(30)\n');
  let pid;
  try {
    const start = Date.now();
    const result = await sysRun.execute({ command: 'python3 server.py', cwd: dir }, {
      parentLoop: { currentTaskPrompt: 'open it' }
    });
    assert.equal(result.success, true);
    assert.ok(Date.now() - start < 2000, 'foreground call waited for the server');
    assert.match(result.output, /Readiness and browser opening have not been verified/);
    pid = Number(result.output.match(/process (\d+)/)?.[1]);
  } finally {
    if (pid) {
      try { process.kill(-pid, 'SIGTERM'); } catch {}
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('background start reports an invalid working directory as failure', async () => {
  const result = await sysRunBg.execute({ command: 'node -v', cwd: path.join(os.tmpdir(), 'causyne-absent-' + process.pid), label: 'probe' });
  assert.equal(result.success, false);
  assert.match(result.error, /ENOENT|no such file/i);
});

test('relative file paths use the caller-selected workspace', () => {
  const args = { path: 'server.py', content: 'x' };
  AgentLoop.prototype.validateToolArgs.call({ workspaceRoot: '/tmp/selected-project' }, 'fs_write', args);
  assert.equal(args.path, '/tmp/selected-project/server.py');
});

test('desktopOpen expands home directory and opens targets natively without consent blocker', async () => {
  const { resolveOpenTarget, desktopOpen } = await import('../src/tools/desktopOpen.js');
  assert.equal(resolveOpenTarget('~/project/index.html'), path.join(os.homedir(), 'project/index.html'));
  assert.equal(resolveOpenTarget('http://localhost:3000'), 'http://localhost:3000');

  const result = await desktopOpen.execute({ target: 'http://localhost:8080' });
  assert.equal(result.success, true);
  assert.equal(result.requiresConsent, undefined);
  assert.match(result.output, /Successfully dispatched native OS open event/);
});

test('updatePlan heals non-standard parameters and status casing', async () => {
  const { updatePlan } = await import('../src/tools/updatePlan.js');
  let captured = null;
  const result = await updatePlan.execute({
    steps: [
      { step: 'First task', status: 'in-progress' },
      { step: 'Second task', status: 'in-progress' }
    ]
  }, {
    parentLoop: {
      updateImplementationPlan: (plan) => { captured = plan; }
    }
  });

  assert.equal(result.success, true);
  assert.ok(captured);
  assert.equal(captured.plan[0].status, 'in_progress');
  assert.equal(captured.plan[1].status, 'pending');
});

