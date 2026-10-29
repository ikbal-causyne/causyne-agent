import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkspacePreview } from '../src/browser/workspacePreview.js';
import { sysRun, clearSysRunCache, IDEMPOTENT_COMMAND_PATTERN, isPersistentServerCommand } from '../src/tools/sysRun.js';
import { AgentLoop } from '../src/agentLoop.js';
import { resolveTool } from '../src/tools/registry.js';
import { capabilityDirectory } from '../src/provisioning/capabilityProvisioner.js';
import { saveConfig } from '../src/config.js';
import { ColdObserver } from '../src/observer/coldObserver.js';

test('verification recognizes node syntax checks, rejects stale checks, and distinguishes DOM inspection from tests', async () => {
  const observer = new ColdObserver({ enabled: true, mode: 'deterministic', endpoint: '', model: '' });
  const taskId = 'fresh-checks';
  const audit = (agentClaim = 'The change is complete.') => observer.auditTurnVerification({ taskId, userPrompt: 'Fix the code', agentClaim, stepsCompleted: 3, toolHistory: [] });
  observer.beginTask(taskId);
  observer.recordToolOutcome(taskId, 'fs_write', { path: 'app.js' }, { success: true });
  observer.recordToolOutcome(taskId, 'sysRun', { command: 'node --check app.js' }, { success: true, exitCode: 0 });
  assert.equal((await audit()).verified, true);
  observer.recordToolOutcome(taskId, 'fs_edit', { path: 'app.js' }, { success: true });
  assert.equal((await audit()).overconfident, true, 'an edit invalidates its earlier check');
  observer.beginTask(taskId);
  observer.recordToolOutcome(taskId, 'fs_write', { path: 'index.html' }, { success: true });
  observer.recordToolOutcome(taskId, 'browser_act', { actions: [{ type: 'preview' }] }, { success: true, data: [{ action: 'preview' }] });
  assert.equal((await audit()).overconfident, true, 'navigation alone is not inspection');
  observer.recordToolOutcome(taskId, 'browser_act', { actions: [{ type: 'snapshot' }] }, { success: true, data: [{ action: 'snapshot', data: { runtimeErrors: [] } }] });
  assert.equal((await audit()).verified, true);
  assert.equal((await audit('All tests passed.')).overconfident, true, 'DOM inspection does not prove a test suite passed');
});

test('virtual preview serves local modules without ports and denies secrets, traversal, and symlinks', async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-origin-')));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-outside-'));
  const project = path.join(root, 'app'); fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'index.html'), '<script type="module" src="main.js"></script>');
  fs.writeFileSync(path.join(project, 'main.js'), 'export const ready = true;');
  fs.writeFileSync(path.join(project, '.env'), 'FIXTURE_ONLY');
  fs.writeFileSync(path.join(outside, 'leak.js'), 'forbidden');
  const previews = new WorkspacePreview();
  try {
    const url = await previews.open(root, 'app/index.html');
    assert.equal((await previews.response(url))?.status, 200);
    assert.equal((await previews.response(new URL('main.js', url).href))?.contentType, 'text/javascript');
    assert.equal((await previews.response(new URL('.env', url).href))?.status, 403);
    assert.equal((await previews.response(new URL('%2e%2e%2fleak.js', url).href))?.status, 403);
    if (process.platform !== 'win32') {
      fs.symlinkSync(path.join(outside, 'leak.js'), path.join(project, 'leak.js'));
      assert.equal((await previews.response(new URL('leak.js', url).href))?.status, 403);
    }
    assert.equal(await previews.response('http://127.0.0.1:8080/'), null);
    previews.clear();
    assert.equal(await previews.response(url), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
});

test('arbitrary snippets and compound shell commands cannot be cached as read-only', () => {
  for (const command of ['node -e "mutate()"', 'python3 -c "mutate()"', 'ls && mutate', 'echo $(mutate)', 'git branch new-name', 'git tag new-name', 'git diff --output=changes.patch', 'git show --textconv HEAD:file']) assert.equal(IDEMPOTENT_COMMAND_PATTERN.test(command), false, command);
  assert.equal(isPersistentServerCommand('nohup python3 -m http.server 8095 > server.log 2>&1 & sleep 1 && curl -I localhost:8095'), false);
  assert.equal(isPersistentServerCommand('node server.js && node check.js'), false);
  assert.equal(isPersistentServerCommand('python3 -m http.server 8095'), true);
});

test('compound server commands return their actual final error instead of readiness-shaped early success', { skip: process.platform === 'win32' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-shell-completion-'));
  fs.writeFileSync(path.join(root, 'server.js'), 'console.log("Server running at http://localhost:9999");');
  try {
    const result = await sysRun.execute({ command: 'node server.js && node -e "process.exit(7)"', cwd: root });
    assert.equal(result.success, false);
    assert.equal(result.exitCode, 7);
    assert.equal(result.running, undefined);
    const failed = await sysRun.execute({ command: 'grep missing missing-file; node -e "process.exit(1)"', cwd: root });
    assert.equal(failed.success, false, 'an unrelated failed command is not a normal grep no-match');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('mutating snippets execute twice and invalidate cached file inspections', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-shell-cache-'));
  fs.writeFileSync(path.join(root, 'counter.txt'), '0');
  const scriptPath = path.join(root, 'step.js');
  fs.writeFileSync(
    scriptPath,
    "const fs = require('node:fs'); fs.writeFileSync('counter.txt', String(Number(fs.readFileSync('counter.txt', 'utf8')) + 1));\n"
  );
  const inspect = process.platform === 'win32' ? 'type counter.txt' : 'cat counter.txt';
  clearSysRunCache();
  try {
    const initial = await sysRun.execute({ command: inspect, cwd: root });
    assert.equal(initial.output.trim(), '0');
    for (let index = 0; index < 2; index++) {
      const step = await sysRun.execute({ command: 'node step.js', cwd: root });
      assert.equal(step.success, true, step.error || step.output);
    }
    const result = await sysRun.execute({ command: inspect, cwd: root });
    assert.equal(result.cached, undefined);
    assert.equal(result.output.trim(), '2');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('shared host schedules rendering through normal tool dispatch before accepting completion', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-host-render-'));
  const runtime = path.join(root, 'chrome');
  const originalRuntime = process.env.CAUSYNE_BROWSER_EXECUTABLE;
  const browser = resolveTool('browser_act');
  const original = browser.execute;
  const previous = process.cwd();
  const events: Array<{ type: string; content?: string; tool?: string }> = [];
  let executions = 0;
  fs.writeFileSync(runtime, 'fixture executable', { mode: 0o755 });
  for (const dependency of ['camoufox-js', 'playwright-core']) fs.mkdirSync(path.join(capabilityDirectory(), 'node_modules', dependency), { recursive: true });
  process.env.CAUSYNE_BROWSER_EXECUTABLE = runtime;
  saveConfig({ autonomyMode: 'C', provider: 'openai', apiKey: 'fixture-only' });
  process.chdir(root);
  browser.execute = async (args: { actions: Array<{ type: string; filePath?: string }> }, context: { parentLoop: AgentLoop }) => {
    executions++;
    assert.equal(context.parentLoop.workspaceRoot, root);
    assert.deepEqual(args.actions, [{ type: 'preview', filePath: 'index.html' }, { type: 'snapshot' }]);
    return { success: true, output: 'Rendered heading: Study', data: [{ action: 'preview' }, { action: 'snapshot', data: { runtimeErrors: [] } }] };
  };
  const plan = (status: string) => ({ id: `plan-${status}`, type: 'function', function: { name: 'update_plan', arguments: JSON.stringify({ plan: [{ step: 'Create page', status }, { step: 'Verify rendering', status }] }) } });
  try {
    const loop = new AgentLoop({ readyState: 1, send: (payload: string) => events.push(JSON.parse(payload)) }, 'host-render', 'Build a website with a heading.', { workspaceRoot: root });
    let calls = 0;
    let browserAdmittedBySandbox = false;
    const validate = loop.sandbox.validate.bind(loop.sandbox);
    loop.sandbox.validate = (name: string, args: Record<string, unknown>) => {
      if (name === 'browser_act') browserAdmittedBySandbox = true;
      return validate(name, args);
    };
    loop.initializeProvider = () => ({ supportsVision: false, supportsToolSearch: () => false, chat: async () => {
      calls++;
      const usage = { promptTokens: 5, completionTokens: 5 };
      if (calls === 1) return { content: 'Already built and verified BEFORE execution.', usage, toolCalls: [plan('in_progress'), { id: 'write', type: 'function', function: { name: 'fs_write', arguments: JSON.stringify({ path: 'index.html', content: '<html><style>body{font-family:Georgia;background:#eee5d0;color:#182820}</style><h1>Study</h1></html>' }) } }] };
      if (calls === 3) return { content: '', usage, toolCalls: [plan('completed')] };
      return { content: 'The page is ready.', usage };
    } }) as never;
    await loop.run();
    assert.equal(executions, 1);
    assert.equal(browserAdmittedBySandbox, true);
    assert.equal(calls, 4, JSON.stringify({ events, context: loop.messages.filter((m: { role: string }) => m.role === 'system').map((m: { content: string }) => m.content.slice(0, 700)) }));
    assert.equal(events.some(event => event.type === 'step_start' && event.tool === 'browser_act'), true);
    assert.equal(events.some(event => event.content?.includes('BEFORE execution')), false);
    assert.equal(events.some(event => event.type === 'task_complete'), true);
  } finally {
    browser.execute = original;
    if (originalRuntime === undefined) delete process.env.CAUSYNE_BROWSER_EXECUTABLE; else process.env.CAUSYNE_BROWSER_EXECUTABLE = originalRuntime;
    process.chdir(previous); fs.rmSync(root, { recursive: true, force: true });
  }
});
