import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { isLaunchOnlyPrompt, isServerLaunchCommand, launchScopeError, readOnlyScopeError, isReadOnlyOrExplanatoryPrompt } from '../src/launchIntent.js';
import { assessVerification } from '../src/verificationPlan.js';
import { outcomeFromResult } from '../src/observer/evidence.js';
import { stripToolCallMarkup, extractLivePlanFromText } from '../src/implementationPlan.js';
import { isWebIntent } from '../src/toolPacks.js';
import { AntigravityProvider } from '../src/providers/antigravity.js';
import { sysRun, sysRunBg } from '../src/tools/sysRun.js';
import { AgentLoop } from '../src/agentLoop.js';

test('opening an existing project excludes file mutation and unrelated commands', () => {
  assert.equal(isLaunchOnlyPrompt('open it'), true);
  assert.equal(isLaunchOnlyPrompt('preview this project'), true);
  assert.equal(isLaunchOnlyPrompt('open it and edit server.py'), false);
  assert.equal(isLaunchOnlyPrompt('run tests'), false);
  assert.equal(
    isLaunchOnlyPrompt('Run creative_apps with action="verify_bridge" to execute the full cross-platform verification, then run resolve_act with action="inspectActive" and simulate=true'),
    false
  );
  assert.equal(
    isLaunchOnlyPrompt('Execute a strict 5-point verification of the memory_recall and episodicStore pipeline'),
    false
  );
  assert.equal(
    isLaunchOnlyPrompt('sekarang aku ingin ceritanya berlanjut setelah dia membaut bumi milik dia sendiri kemudian dia mulai membawa bebrapa istri dari beberapa dunia pararel masa lalu masa depan mauphun penat dan another galaxy/universe sekitar 20rb istri dan dia masing masing mempunyai anak dari sana dan mulai menananmkan chip pada naka nakanya tersebut agar sellau menjadi baik di buminya tersebut untuk pentingan dan kedamaian manusia yang dari awalnya menghancurkan bumi saling membunuh membuly manusia lain dia sekarnag maembuat sistem dimana bumi yangs anatg damai semua porang sanagt kaya raya semua orang bias berlkeliling dunia semua orang makan enak semuaa orang bersahabt semua orang tidak berselisih semua orang selalu bahagiaa semua orang sudah tidak punya lagi energi maupun emosi negatif karena chip tersebut dan semua kegiatan semua hospitality run by ai yaang di buat oleh pahlawna kita inih'),
    false
  );
  assert.equal(
    isLaunchOnlyPrompt('write a sci-fi novel about a galactic empire where hospitality is run by ai'),
    false
  );
  assert.equal(
    isLaunchOnlyPrompt('explain why the service is run by background processes'),
    false
  );
  assert.equal(
    isLaunchOnlyPrompt('buatkan novel kelanjutan cerita'),
    false
  );
  assert.equal(
    isLaunchOnlyPrompt('launch the app'),
    true
  );
  assert.equal(
    isLaunchOnlyPrompt('play the game'),
    true
  );
  assert.match(launchScopeError('fs_edit', { path: 'server.py' }), /not change/);
  assert.match(launchScopeError('sysRun', { command: 'python3 -c "open(\"server.py\",\"w\")"' }), /does not authorize/);
  assert.match(launchScopeError('sysRun', { command: 'ls -la && rm server.py' }), /chained shell commands/);
  assert.match(launchScopeError('sysRun', { command: 'npm run dev && touch /tmp/unauthorized' }), /chained shell commands/);
  assert.match(launchScopeError('sysRunBg', { command: 'python3 server.py; rm -rf ./data' }), /chained shell commands/);
  assert.match(launchScopeError('terminal_persistent_shell', { command: 'open https://example.com && echo unexpected' }), /chained shell commands/);
  assert.match(launchScopeError('sysRun', { command: 'npm run dev `whoami`' }), /chained shell commands/);
  assert.match(launchScopeError('sysRun', { command: 'npm run dev $(whoami)' }), /chained shell commands/);
  assert.match(launchScopeError('sysRun', { command: 'npm run dev\nrm -rf ./data' }), /chained shell commands/);
  assert.equal(launchScopeError('sysRun', { command: 'open "http://localhost:8000/?test=1&debug=true"' }), null);
  // Opening an app never authorizes terminating unrelated host processes.
  assert.match(launchScopeError('sysRun', { command: 'pkill -f Terminal' }), /Use read-only inspection/);
  assert.match(launchScopeError('sysRunBg', { command: 'kill -9 1' }), /Use read-only inspection/);
  assert.match(launchScopeError('terminal_persistent_shell', { command: 'fuser -k 8080/tcp' }), /Use read-only inspection/);
  assert.equal(launchScopeError('tool_search', {}), null);
  assert.equal(launchScopeError('gitOp', { command: 'status --short' }), null);
  assert.match(launchScopeError('gitOp', { command: 'checkout -- .' }), /Git inspection/);
  assert.match(launchScopeError('gitOp', { command: 'clean -fd' }), /Git inspection/);
  assert.match(launchScopeError('gitOp', { command: 'status; touch /tmp/surprise' }), /Git inspection/);
  assert.match(launchScopeError('gitOp', { command: 'diff --ext-diff' }), /Git inspection/);
  assert.match(readOnlyScopeError('gitOp', { command: 'restore .' }, 'explain current status'), /inspection of Git status/);
  assert.match(readOnlyScopeError('gitOp', { command: 'status; rm -rf ./data' }, 'explain current status'), /inspection of Git status/);
  assert.match(readOnlyScopeError('gitOp', { command: 'show --output=/tmp/out' }, 'explain current status'), /inspection of Git status/);
  assert.equal(readOnlyScopeError('gitOp', { command: 'log -1 --oneline' }, 'explain current status'), null);
  assert.equal(launchScopeError('update_plan', {}), null);
  assert.equal(launchScopeError('desktop_open', { target: '~/village_cat_foundation/index.html' }), null);
  assert.equal(launchScopeError('desktop.open', { target: 'http://localhost:8000' }), null);
  assert.equal(launchScopeError('sysRun', { command: 'open "http://localhost:8000/?test=1&debug=true"' }), null);
  assert.equal(launchScopeError('sysRun', { command: 'ls -la /tmp' }), null);
  // Commands advertised as read-only must not accept mutating command-line flags.
  assert.match(launchScopeError('sysRun', { command: 'find . -delete' }), /Use read-only inspection/);
  assert.match(launchScopeError('sysRun', { command: 'find . -exec rm data +' }), /Use read-only inspection/);
  assert.match(launchScopeError('sysRun', { command: 'git diff --output=/tmp/secret' }), /Use read-only inspection/);
  assert.match(launchScopeError('sysRun', { command: 'rg --pre=sh suspicious' }), /Use read-only inspection/);
  const inquiry = 'explain what files are present';
  assert.match(readOnlyScopeError('sysRun', { command: 'find . -delete' }, inquiry), /only non-mutating/);
  assert.match(readOnlyScopeError('sysRun', { command: 'git show --output=/tmp/file' }, inquiry), /only non-mutating/);
  assert.match(readOnlyScopeError('sysRun', { command: 'rg --pre=sh pattern' }, inquiry), /only non-mutating/);
  assert.equal(readOnlyScopeError('sysRun', { command: 'find . -name package.json' }, inquiry), null);
  assert.equal(launchScopeError('sysRun', { command: 'python3 /tmp/server.py' }), null);
  assert.equal(launchScopeError('sysRun', { command: 'curl -f http://127.0.0.1:8765/' }), null);
  assert.match(launchScopeError('sysRun', { command: 'curl -o server.py http://example.com/' }), /Use read-only inspection/);
  assert.equal(isServerLaunchCommand('python3 /tmp/server.py'), true);
});

test('resumed Antigravity launch preserves peer configuration and the actual host workspace', { skip: process.platform === 'win32' }, async () => {
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
    assert.ok(!calls[0].args.includes('--agent'));
    assert.ok(!calls[1].args.includes('--agent'));
    assert.ok(!calls[1].args.includes('--disable-slash-commands'));
    assert.ok(!calls[1].args.includes('--mode'));
    assert.equal(calls[1].args[calls[1].args.indexOf('--print-timeout') + 1], '90s');
    assert.equal(fs.realpathSync(calls[1].cwd), fs.realpathSync(dir), 'native peer tools use the selected project');
    assert.ok(calls[1].input.includes(JSON.stringify({ workspaceRoot: dir })), 'Causyne paths still target the user-selected project');
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
    assert.equal(result.exitCode, null, 'a running server has no final exit status');
    assert.equal(result.running, true);
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
  assert.equal(args.path, path.resolve('/tmp/selected-project', 'server.py'));
});

test('desktopOpen expands home directory and opens targets natively without consent blocker', async (t) => {
  // Verify native dispatch without opening a real personal browser during tests.
  let dispatched: string[] = [];
  const stub = t.mock.method(childProcess, 'spawn', (_command: string, args: string[]) => {
    dispatched = args;
    return Object.assign(new EventEmitter(), { unref() {} });
  });
  syncBuiltinESMExports();
  try {
    const { resolveOpenTarget, desktopOpen } = await import('../src/tools/desktopOpen.js');
    assert.equal(resolveOpenTarget('~/project/index.html'), path.join(os.homedir(), 'project/index.html'));
    assert.equal(resolveOpenTarget('http://localhost:3000'), 'http://localhost:3000');

    const result = await desktopOpen.execute({ target: 'http://localhost:8080' });
    assert.equal(result.success, true);
    assert.equal(result.requiresConsent, undefined);
    assert.match(result.output, /Successfully dispatched native OS open event/);
    assert.ok(dispatched.includes('http://localhost:8080'));
  } finally {
    stub.mock.restore();
    syncBuiltinESMExports();
  }
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

test('assessVerification treats read-only creative bridge/inspection and probes as non-mutating and accepts probe/capture evidence', () => {
  const verifyBridgeOutcome = outcomeFromResult(
    'creative_apps',
    { action: 'verify_bridge' },
    { success: true },
    100
  );
  const inspectResolveOutcome = outcomeFromResult(
    'resolve_act',
    { action: 'inspectActive', simulate: true },
    { success: true },
    200
  );
  // Read-only creative verification calls must NOT trigger a false Verification (creative) gap
  const readOnlyAssessment = assessVerification({
    outcomes: [verifyBridgeOutcome, inspectResolveOutcome]
  });
  assert.equal(readOnlyAssessment.gaps.length, 0);
  assert.equal(readOnlyAssessment.directive, '');

  // When a real creative mutation occurs, native_engine probe + view_image capture satisfy it without resetting after()
  const realCreativeRender = outcomeFromResult(
    'blender_act',
    { action: 'render', path: '/tmp/scene.png' },
    { success: true },
    300
  );
  const viewImageTextOnly = outcomeFromResult(
    'view_image',
    { path: '/tmp/scene.png' },
    { success: true, _is_image_marker: true, visionDelivered: false },
    400
  );
  const nativeSoundProbe = outcomeFromResult(
    'native_engine',
    { engine: 'sound', action: 'probe', query: '/tmp/audio.wav' },
    { success: true },
    500
  );
  const satisfiedAssessment = assessVerification({
    outcomes: [realCreativeRender, viewImageTextOnly, nativeSoundProbe]
  });
  assert.equal(satisfiedAssessment.gaps.length, 0);
});

test('stripToolCallMarkup strips trailing partial <t and <to tags and extractLivePlanFromText ignores mid-stream unclosed JSON', () => {
  assert.equal(stripToolCallMarkup('<t'), '');
  assert.equal(stripToolCallMarkup('<to'), '');
  assert.equal(stripToolCallMarkup('<tool_call'), '');
  assert.equal(stripToolCallMarkup('Hello world\n<to'), 'Hello world');

  // Unclosed mid-stream <tool_call> must not fire during live streaming (allowTrailing = false)
  const partialStream = '<tool_call>{"name":"update_plan","arguments":{"plan":[{"id":"s1","step":"Inspecting';
  assert.equal(extractLivePlanFromText(partialStream, false), null);
  // Once closed, it extracts cleanly
  const completeStream = '<tool_call>{"name":"update_plan","arguments":{"plan":[{"id":"s1","step":"Inspecting","status":"in_progress"}]}}</tool_call>';
  assert.equal(extractLivePlanFromText(completeStream, false)?.plan.length, 1);
});

test('creative bridge DOM/Python simulator prompt does not trigger false web rendered-page verification failure', async () => {
  const prompt = 'Run creative_apps with action="verify_bridge" to execute the full cross-platform (macOS/Windows/Linux) and DOM/Python simulator verification across Adobe Photoshop, Premiere Pro, After Effects, DaVinci Resolve, Unreal Engine 5, Unity, and Godot, then run resolve_act with action="inspectActive" and simulate=true, and report all verification results.';
  assert.equal(isWebIntent(prompt), false, 'Adobe DOM/Python simulator must not be misclassified as web frontend intent');

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-creative-bridge-loop-'));
  fs.writeFileSync(path.join(workspace, 'package.json'), '{}');
  const events: Array<{ type: string; message?: string; content?: string; plan?: Array<{ status: string }> }> = [];

  try {
    const loop = new AgentLoop(
      { readyState: 1, send: (payload: string) => events.push(JSON.parse(payload)) },
      'creative-bridge-e2e',
      prompt,
      { workspaceRoot: workspace }
    );
    let turn = 0;
    const model = {
      supportsVision: false,
      supportsToolSearch: () => false,
      chat: async () => {
        turn++;
        if (turn === 1) {
          return {
            content: '',
            toolCalls: [
              { id: 'tc1', type: 'function', function: { name: 'creative_apps', arguments: JSON.stringify({ action: 'verify_bridge' }) } },
              { id: 'tc2', type: 'function', function: { name: 'resolve_act', arguments: JSON.stringify({ action: 'inspectActive', simulate: true }) } }
            ],
            usage: { promptTokens: 20, completionTokens: 15 }
          };
        }
        return {
          content: 'Both passed: creative_apps verify_bridge and resolve_act inspectActive (simulate=true) verified.',
          usage: { promptTokens: 30, completionTokens: 20 }
        };
      }
    };
    loop.initializeProvider = () => model as never;
    loop.llm = model as never;

    await loop.run();

    assert.equal(turn, 2, 'must complete in 2 turns without web guard retry');
    assert.equal(events.some((e) => e.type === 'error'), false, `unexpected error: ${JSON.stringify(events.filter((e) => e.type === 'error'))}`);
    assert.equal(events.some((e) => e.type === 'task_complete'), true, 'must emit task_complete');
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});





test('questions about how to fix code never authorize workspace mutations', () => {
  assert.equal(isReadOnlyOrExplanatoryPrompt('How do I fix the failed build?'), true);
  assert.equal(isReadOnlyOrExplanatoryPrompt('Please explain how to delete an obsolete file'), true);
  assert.equal(isReadOnlyOrExplanatoryPrompt('Review the code and fix the bugs'), false);
  assert.equal(isReadOnlyOrExplanatoryPrompt('Explain the issue, then implement the fix'), false);
  assert.match(readOnlyScopeError('fs_delete', { path: 'data.json' }, 'How do I delete this file?'), /read-only inquiry/);
  assert.match(readOnlyScopeError('sysRun', { command: 'npm install' }, 'Explain how to install packages'), /non-mutating/);
});
