import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentLoop, isDesktopWallpaperChangePrompt, isGenericHandoffResponse, isMidTaskProgressText, isProviderPlanOrQuotaRefusal } from '../src/agentLoop.js';
import { AntigravityProvider } from '../src/providers/antigravity.js';
import { AcpProvider } from '../src/providers/acp.js';
import { actionLimitFor } from '../src/providers/budgetEnforcer.js';
import { extractLivePlanFromText, normalizePeerPlanEntries } from '../src/implementationPlan.js';
import { isWebIntent } from '../src/toolPacks.js';
import { CodeStreamRenderer } from '../src/tui/codeStreamRenderer.js';
import { sessionSidebarRows } from '../src/tui/sessionSidebar.js';
import { stripAnsi } from '../src/tui/text.js';

test('desktop safety limits are terminal errors instead of retrying paid turns', () => {
  const loop = new AgentLoop({ readyState: 1, send: () => {} }, 'desktop-limit-regression', 'change my desktop picture');
  assert.equal(loop.classifyError({ code: 'AGY_NATIVE_ACTION_BUDGET', message: 'Native action limit reached' }), 'fatal');
  assert.equal(loop.classifyError({ code: 'AGY_DESKTOP_TASK_LIMIT', message: 'Desktop time limit reached' }), 'fatal');
  assert.equal(loop.classifyError({ message: 'network error after model step', partialUsage: { promptTokens: 90, completionTokens: 10 } }), 'fatal');
});

test('media inspection recovery is bounded and never reports an unfinished edit as complete', async () => {
  const previousDirectory = process.cwd();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-media-recovery-'));
  fs.writeFileSync(path.join(workspace, 'package.json'), '{}');
  process.chdir(workspace);
  try {
    const events: Array<{ type: string; message?: string }> = [];
    const loop = new AgentLoop(
      { readyState: 1, send: (payload: string) => events.push(JSON.parse(payload)) },
      'media-recovery-regression', 'the apple still has no background in Blender',
      { workspaceRoot: workspace }
    );
    let calls = 0;
    loop.initializeProvider = () => ({
      supportsVision: false,
      supportsToolSearch: () => false,
      chat: async () => {
        calls += 1;
        throw Object.assign(new Error('Repeated read-only inspections'), {
          code: 'AGY_EXPLORATION_LOOP', inspectionCount: 10,
          partialUsage: { promptTokens: 100, completionTokens: 10 }
        });
      }
    }) as never;
    await loop.run();
    assert.equal(calls, 2);
    assert.equal(events.some((event) => event.type === 'task_complete'), false);
    assert.equal(events.some((event) => event.type === 'notice' && event.message?.includes('direct edit')), true);
    assert.equal(events.some((event) => event.type === 'error' && event.message?.includes('remains unfinished')), true);
  } finally {
    process.chdir(previousDirectory);
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('a generic handoff after native actions cannot be reported as task completion', async () => {
  const previousDirectory = process.cwd();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-handoff-'));
  fs.writeFileSync(path.join(workspace, 'package.json'), '{}');
  process.chdir(workspace);
  try {
    const events: Array<{ type: string; message?: string; content?: string }> = [];
    const loop = new AgentLoop(
      { readyState: 1, send: (payload: string) => events.push(JSON.parse(payload)) },
      'handoff-regression', 'search and download a wallpaper and change my desktop picture',
      { workspaceRoot: workspace }
    );
    const model = {
      supportsVision: false,
      supportsToolSearch: () => false,
      chat: async () => ({
        content: 'Acknowledged. Vision capabilities and browser actions are noted. Let me know what you would like to do next.',
        externalActions: [{ name: 'search_web', status: 'completed' }],
        usage: { promptTokens: 10, completionTokens: 8 }
      })
    };
    loop.initializeProvider = () => model as never;
    await loop.run();
    assert.equal(events.some((event) => event.type === 'task_complete'), false);
    assert.equal(events.some((event) => event.type === 'agent_message' && event.content?.startsWith('Acknowledged')), false);
    assert.equal(events.some((event) => event.type === 'error' && event.message?.includes('not verified')), true);
    assert.equal(isGenericHandoffResponse('Changed the desktop wallpaper. Let me know if you want another.'), false);
  } finally {
    process.chdir(previousDirectory);
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('a claimed macOS wallpaper change needs an actual changed desktop readback', { skip: process.platform !== 'darwin' }, async () => {
  const previousDirectory = process.cwd();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-wallpaper-readback-'));
  fs.writeFileSync(path.join(workspace, 'package.json'), '{}');
  process.chdir(workspace);
  try {
    const events: Array<{ type: string; message?: string }> = [];
    const loop = new AgentLoop(
      { readyState: 1, send: (payload: string) => events.push(JSON.parse(payload)) },
      'wallpaper-readback-regression', 'change my desktop picture',
      { workspaceRoot: workspace }
    );
    const model = {
      supportsVision: false,
      supportsToolSearch: () => false,
      chat: async () => ({
        content: 'Changed the desktop picture.',
        externalActions: [{ name: 'run_command', status: 'completed' }],
        usage: { promptTokens: 10, completionTokens: 8 }
      })
    };
    loop.initializeProvider = () => model as never;
    await loop.run();
    assert.equal(isDesktopWallpaperChangePrompt('please change my desktop picture'), true);
    assert.equal(events.some((event) => event.type === 'task_complete'), false);
    assert.equal(events.some((event) => event.type === 'error' && event.message?.includes('macOS readback')), true);
  } finally {
    process.chdir(previousDirectory);
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('an actionable request fails visibly after repeated greetings without showing them as answers', async () => {
  const previousDirectory = process.cwd();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-greeting-'));
  fs.writeFileSync(path.join(workspace, 'package.json'), '{}');
  process.chdir(workspace);

  try {
    const events: Array<{ type: string; message?: string }> = [];
    const loop = new AgentLoop({ readyState: 1, send: (payload: string) => events.push(JSON.parse(payload)) }, 'greeting-regression', 'create a 3js shooting game');
    let calls = 0;
    const model = {
      supportsVision: false,
      supportsToolSearch: () => false,
      chat: async () => {
        calls += 1;
        return { content: 'Hello! How can I help you today?', usage: { promptTokens: 10, completionTokens: 8 } };
      }
    };
    loop.initializeProvider = () => model as never;

    await loop.run();

    assert.equal(calls, 3);
    assert.equal(events.some((event) => event.type === 'agent_message'), false);
    assert.equal(events.some((event) => event.type === 'error' && event.message?.includes('No work was completed')), true);
    assert.equal(events.some((event) => event.type === 'task_complete'), false);
    assert.equal(loop.unlockedPacks.has('game'), false);
  } finally {
    process.chdir(previousDirectory);
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('planning-only responses cannot report an unstarted task as complete', async () => {
  const previousDirectory = process.cwd();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-no-progress-'));
  fs.writeFileSync(path.join(workspace, 'package.json'), '{}');
  process.chdir(workspace);

  try {
    const events: Array<{ type: string; message?: string }> = [];
    const loop = new AgentLoop({ readyState: 1, send: (payload: string) => events.push(JSON.parse(payload)) }, 'planning-regression', 'create a 3js shooting game');
    const model = {
      supportsVision: false,
      supportsToolSearch: () => false,
      chat: async () => ({ content: 'I will create the game next.', usage: { promptTokens: 10, completionTokens: 8 } })
    };
    loop.initializeProvider = () => model as never;

    await loop.run();

    assert.equal(events.some((event) => event.type === 'agent_message'), false);
    assert.equal(events.some((event) => event.type === 'error' && event.message?.includes('No work was completed')), true);
    assert.equal(events.some((event) => event.type === 'status' && event.message === 'Task completed.'), false);
    assert.equal(events.some((event) => event.type === 'task_complete'), false);
  } finally {
    process.chdir(previousDirectory);
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('isMidTaskProgressText identifies intermediate progress announcements and ignores completed answers', () => {
  assert.equal(
    isMidTaskProgressText('Real assets verified. Writing the Tesla-style redesign now.'),
    true
  );
  assert.equal(
    isMidTaskProgressText(
      'Let me look at the newer assets to know what they actually show.\nOfficial Tesla channel videos found. Pulling their real stills and confirming embeddability.'
    ),
    true
  );
  assert.equal(
    isMidTaskProgressText('Checking the build output and updating styles next.'),
    true
  );
  assert.equal(
    isMidTaskProgressText('Created cake.html and verified the layout in the workspace.'),
    false
  );
  assert.equal(
    isMidTaskProgressText('Everything is complete. Let me know if you want any adjustments!'),
    false
  );
});

test('AgentLoop auto-continues progress but does not certify a web page without rendered inspection', async () => {
  const previousHome = process.env.CAUSYNE_HOME;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-temp-home-'));
  process.env.CAUSYNE_HOME = tempHome;
  const previousDirectory = process.cwd();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-midtask-continue-'));
  fs.writeFileSync(path.join(workspace, 'package.json'), '{}');
  process.chdir(workspace);

  try {
    const events: Array<{ type: string; content?: string; message?: string }> = [];
    const loop = new AgentLoop(
      { readyState: 1, send: (payload: string) => events.push(JSON.parse(payload)) },
      'midtask-regression',
      'redesign the roadster landing page',
      { workspaceRoot: workspace }
    );
    let calls = 0;
    const model = {
      supportsVision: false,
      supportsToolSearch: () => false,
      chat: async () => {
        calls += 1;
        if (calls === 1) {
          return {
            content: 'Real assets verified. Writing the Tesla-style redesign now.',
            externalActions: [
              { name: 'read_file', status: 'completed', detail: 'hero.jpg' },
              { name: 'run_command', status: 'completed', detail: 'ls -la' }
            ],
            usage: { promptTokens: 20, completionTokens: 12 }
          };
        }
        if (calls === 2) {
          return {
            content:
              'Let me look at the newer assets to know what they actually show.\nOfficial Tesla channel videos found. Pulling their real stills and confirming embeddability.',
            externalActions: [
              { name: 'run_command', status: 'completed', detail: 'python3 sheet.py' }
            ],
            incompleteTurn: true,
            usage: { promptTokens: 25, completionTokens: 18 }
          };
        }
        fs.writeFileSync(path.join(workspace, 'index.html'), '<!doctype html><html lang="en"><head><title>Roadster</title></head><body><main><h1>Roadster</h1></main></body></html>');
        return {
          content: 'Redesigned index.html and verified all Roadster assets.',
          externalActions: [
            { name: 'write_file', status: 'completed', detail: 'index.html' }
          ],
          usage: { promptTokens: 30, completionTokens: 15 }
        };
      }
    };
    loop.initializeProvider = () => model as never;
    loop.llm = model as never;

    await loop.run();

    assert.equal(calls, 4, 'loop must also give the missing browser setup directive a follow-up step');
    assert.equal(loop.stepsCompleted, 5, 'completed external actions must be counted in stepsCompleted');
    assert.equal(events.some((event) => event.type === 'agent_message' && event.content?.includes('verified all Roadster assets')), false);
    assert.equal(events.some((event) => event.type === 'task_complete'), false);
    assert.equal(events.some((event) => event.type === 'error' && event.message?.includes('rendered-page verification did not succeed')), true, JSON.stringify(events));
  } finally {
    process.chdir(previousDirectory);
    if (previousHome !== undefined) process.env.CAUSYNE_HOME = previousHome;
    else delete process.env.CAUSYNE_HOME;
    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('AntigravityProvider detects incomplete print-timeout turns and preserves conversation across rotating taskIds in the same session', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-agy-midtask-'));
  const agy = path.join(dir, 'agy');
  const argsLog = path.join(dir, 'args.jsonl');
  fs.writeFileSync(
    agy,
    `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argsLog)}, JSON.stringify(args) + '\\n');
let input = '';
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  const emit = (ev) => process.stdout.write(JSON.stringify(ev) + '\\n');
  const isResumed = args.includes('--conversation');
  emit({ event: 'init', conversation_id: 'conv-session-42' });
  if (!isResumed) {
    emit({ event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'Let me look at the newer assets.' } });
    emit({ event: 'step_update', step_update: { step_type: 'tool', state: 'ACTIVE', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'python3 build_sheet.py' } } } });
    emit({ event: 'step_update', step_update: { step_type: 'tool', state: 'DONE', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: 'python3 build_sheet.py' } } } });
    process.stderr.write('[agy] print timeout after 300s with turn in progress; returning partial output\\n');
    emit({ event: 'result', result: { status: 'SUCCESS', conversation_id: 'conv-session-42', response: '', usage: { input_tokens: 10, output_tokens: 5 } } });
  } else {
    emit({ event: 'step_update', step_update: { step_type: 'tool', state: 'ACTIVE', tool_name: 'write_file', tool_info: { name: 'write_file', parameters: { Path: 'index.html' } } } });
    emit({ event: 'step_update', step_update: { step_type: 'tool', state: 'DONE', tool_name: 'write_file', tool_info: { name: 'write_file', parameters: { Path: 'index.html' } } } });
    emit({ event: 'result', result: { status: 'SUCCESS', conversation_id: 'conv-session-42', response: 'Completed index.html redesign.', usage: { input_tokens: 12, output_tokens: 8 } } });
  }
});
`,
    { mode: 0o755 }
  );

  try {
    const provider = new AntigravityProvider({ command: agy, model: 'Claude Opus 5.5 (High)' });
    const turn1 = await provider.chat([{ role: 'user', content: 'Redesign roadster' }], {
      taskId: 'cli_chat_1001',
      conversationId: 's_session_persist_1'
    });
    assert.equal(turn1.incompleteTurn, true, 'print-timeout mid-turn must be flagged as incompleteTurn');
    assert.equal(turn1.content, 'Let me look at the newer assets.');

    const turn2 = await provider.chat(
      [
        { role: 'user', content: 'Redesign roadster' },
        { role: 'assistant', content: turn1.content },
        { role: 'user', content: 'continue' }
      ],
      {
        taskId: 'cli_chat_1002',
        conversationId: 's_session_persist_1'
      }
    );
    assert.equal(turn2.incompleteTurn, undefined);
    assert.equal(turn2.content, 'Completed index.html redesign.');

    const loggedArgs = fs
      .readFileSync(argsLog, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(loggedArgs.length, 2);
    assert.equal(loggedArgs[0][loggedArgs[0].indexOf('--print-timeout') + 1], '1800s');
    assert.equal(loggedArgs[1].includes('--conversation'), true, 'second turn in same session must reuse --conversation even when taskId rotated');
    assert.equal(loggedArgs[1][loggedArgs[1].indexOf('--conversation') + 1], 'conv-session-42');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Antigravity stops a runaway headless turn at its default token ceiling without replaying it', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-agy-ceiling-'));
  const agy = path.join(dir, 'agy');
  const countFile = path.join(dir, 'invocations');
  fs.writeFileSync(agy, `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(countFile)}, '1');
process.stdout.write(JSON.stringify({event:'step_update',step_update:{step_type:'agent_response',state:'DONE',step_index:1,usage:{input_tokens:100001,output_tokens:1}}})+'\\n');
setTimeout(() => {}, 10000);
`, { mode: 0o755 });
  try {
    const provider = new AntigravityProvider({ command: agy, model: 'Claude Opus 5.5 (High)' });
    await assert.rejects(
      provider.chat([{ role: 'user', content: 'build a page' }], { taskId: 'ceiling-test' }),
      (error: unknown) => {
        const e = error as { code?: string; tokenLimit?: number; partialUsage?: { promptTokens: number } };
        assert.equal(e.code, 'AGY_TOKEN_BUDGET');
        assert.equal(e.tokenLimit, 100_000);
        assert.equal(e.partialUsage?.promptTokens, 100_001);
        return true;
      }
    );
    assert.equal(fs.readFileSync(countFile, 'utf8'), '1', 'a paid partial turn must not be retried');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CodeStreamRenderer increments stepCount on nativeStep notice events', () => {
  const renderer = new CodeStreamRenderer({ out: { write: () => {}, columns: 100 } });
  renderer.resetTurn();
  assert.equal(renderer.stepCount, 0);
  renderer.handle({ type: 'notice', tone: 'muted', nativeStep: true, message: 'Antigravity read_file hero.jpg' });
  renderer.handle({ type: 'notice', tone: 'muted', nativeStep: true, message: 'Antigravity run_command ls' });
  renderer.handle({ type: 'notice', tone: 'muted', message: 'Context compacted' });
  assert.equal(renderer.stepCount, 2);
});

test('provider plan refusal stops immediately without polluting history or poisoning consecutiveThinkingSteps on the next run', async () => {
  const previousDirectory = process.cwd();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-horse-tinder-regression-'));
  fs.writeFileSync(path.join(workspace, 'package.json'), '{}');
  process.chdir(workspace);

  try {
    const events: Array<{ type: string; message?: string; content?: string }> = [];
    const loop = new AgentLoop(
      { readyState: 1, send: (payload: string) => events.push(JSON.parse(payload)) },
      'cli_chat_1',
      'build me a 3d horse this is horse tinder in three.js',
      { workspaceRoot: workspace }
    );

    let cursorCalls = 0;
    loop.initializeProvider = () => ({
      supportsVision: false,
      supportsToolSearch: () => false,
      chat: async () => {
        cursorCalls += 1;
        return {
          content: 'Upgrade your plan to continue',
          usage: { promptTokens: 10, completionTokens: 5 }
        };
      }
    }) as never;

    await loop.run();
    assert.equal(isProviderPlanOrQuotaRefusal('Upgrade your plan to continue'), true);
    assert.equal(cursorCalls, 1, 'plan refusal must stop immediately without 3 retry nudges');
    assert.equal(
      loop.messages.some((m: any) => typeof m.content === 'string' && m.content.includes('Upgrade your plan to continue')),
      false,
      'plan refusal text must not remain in loop.messages'
    );

    // Now simulate switching to OpenCode in the same session and running the second task
    events.length = 0;
    loop.taskId = 'cli_chat_2';
    loop.userPrompt = 'make horse tinder 3d in thre.js';
    loop.currentTaskPrompt = 'make horse tinder 3d in thre.js';

    let opencodeCalls = 0;
    const opencodePrompts: any[] = [];
    const opencodeModel = {
      supportsVision: false,
      supportsToolSearch: () => false,
      chat: async (msgs: any[]) => {
        opencodeCalls += 1;
        opencodePrompts.push(msgs.map((m) => ({ role: m.role, content: m.content })));
        if (opencodeCalls === 1) {
          // Turn 1: 23 completed external actions + 1 failed /tmp read, ending incomplete
          return {
            content: '',
            externalActions: [
              { name: 'fs_write', status: 'completed', detail: path.join(workspace, 'index.html') },
              { name: 'fs_read', status: 'failed', detail: '/tmp/horse.png' }
            ],
            incompleteTurn: true,
            usage: { promptTokens: 100, completionTokens: 50 }
          };
        }
        if (opencodeCalls === 2) {
          // Turn 2: 0 completed actions, 1 failed cp /tmp/horse.png action
          return {
            content: '',
            externalActions: [
              { name: 'sysRun', status: 'failed', detail: 'cp /tmp/horse.png .shots/shot1.png' }
            ],
            incompleteTurn: true,
            usage: { promptTokens: 80, completionTokens: 20 }
          };
        }
        // Turn 3: recovers by writing inside workspace and invoking browser_act or finishing HTML inspection
        fs.writeFileSync(
          path.join(workspace, 'index.html'),
          '<!doctype html><html lang="en"><head><title>Equus 3D</title></head><body><main><h1>Equus 3D</h1></main></body></html>'
        );
        return {
          content: 'Completed Equus 3D inside workspace.',
          externalActions: [
            { name: 'fs_read', status: 'completed', detail: path.join(workspace, 'index.html') }
          ],
          usage: { promptTokens: 60, completionTokens: 25 }
        };
      }
    };
    loop.initializeProvider = () => opencodeModel as never;
    loop.llm = opencodeModel as never;

    await loop.run();

    assert.equal(isWebIntent('make horse tinder 3d in thre.js'), true, 'thre.js typo must be recognized as web intent');
    assert.equal(
      opencodeCalls >= 3,
      true,
      `loop must not abort at Step 24 after Turn 1 incomplete + Turn 2 blocked /tmp action (got ${opencodeCalls} calls)`
    );
    const turn3SystemNotices = opencodePrompts[2]
      .filter((m: any) => m.role === 'system' || m.role === 'user')
      .map((m: any) => String(m.content))
      .join('\n');
    assert.equal(
      turn3SystemNotices.includes('Never read, copy (cp/mv), or write files in /tmp'),
      true,
      'recovery notice must explicitly warn against reading or copying from /tmp'
    );
  } finally {
    process.chdir(previousDirectory);
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('AcpProvider formatPromptBlocks includes ACP tool-routing rules and strips synthetic No final response placeholders', () => {
  const provider = new AcpProvider({ peer: 'opencode', model: 'opencode/deepseek' });
  const formatted = provider.formatConversation([
    { role: 'system', content: 'System prompt\n[Current Available Tools]:\n- browser_act: Inspect page' },
    { role: 'user', content: 'make horse tinder 3d in thre.js' }
  ]);
  assert.equal(formatted.includes('[ACP Tool Routing & Workspace Boundary Rules]'), true);
  assert.equal(formatted.includes('NEVER invoke them as native function calls (`to=browser_act` or `to=update_plan`)'), true);
  assert.equal(formatted.includes('NEVER write to, read from, or `cp`/`mv` paths in `/tmp`'), true);
});

test('AgentLoop extracts reasoning Plan checklists and todowrite updates into sidebar Plan and allows 120 actions for web_engineering', async () => {
  assert.equal(actionLimitFor('web_engineering'), 120);
  assert.equal(actionLimitFor('general'), 35);

  const reasoningSample = [
    'Greenfield: create `horse-simulator/` at workspace root. Use CDN three.js via importmap.',
    '',
    'Plan:',
    '1. Scaffold project structure (index.html, styles.css, src modules).',
    '2. Build procedural horse model + skeleton rig.',
    '3. Implement gait engine and locomotion/camera controls.',
    '4. Build environment and HUD design.',
    '5. Run preview + verify visuals, fix issues.',
    '',
    'Let me design the code carefully.'
  ].join('\n');

  const extracted = extractLivePlanFromText(reasoningSample, false);
  assert.ok(extracted);
  assert.equal(extracted.plan.length, 5);
  assert.equal(extracted.plan[0]?.status, 'in_progress');
  assert.equal(extracted.plan[1]?.status, 'pending');

  const todoNormalized = normalizePeerPlanEntries({
    todos: [
      { content: 'Scaffold horse-simulator project and vendor Three.js', status: 'in_progress', priority: 'high' },
      { content: 'Build procedural horse model with articulated rig', status: 'pending', priority: 'high' },
      { content: 'Preview, visually verify and fix issues', status: 'pending', priority: 'high' }
    ]
  });
  assert.ok(todoNormalized);
  assert.equal(todoNormalized.plan.length, 3);
  assert.equal(todoNormalized.plan[0]?.step, 'Scaffold horse-simulator project and vendor Three.js');

  const previousDirectory = process.cwd();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-sidebar-plan-'));
  fs.writeFileSync(path.join(workspace, 'package.json'), '{}');
  process.chdir(workspace);

  try {
    const events: Array<{ type: string; plan?: Array<{ id: string; text: string; status: string }> }> = [];
    let latestSidebarPlan: Array<{ id?: string; text?: string; step?: string; status?: string }> = [];
    const renderer = new CodeStreamRenderer({ out: { write: () => {}, columns: 140 } });
    (renderer as any).onPlanChange = (plan: Array<{ id?: string; text?: string; status?: string }>) => {
      latestSidebarPlan = plan;
      return 'sidebar';
    };

    const loop = new AgentLoop(
      {
        readyState: 1,
        send: (payload: string) => {
          const parsed = JSON.parse(payload);
          events.push(parsed);
          renderer.handle(parsed);
        }
      },
      'sidebar-plan-regression',
      'build a 3d horse simulator using three.js',
      { workspaceRoot: workspace }
    );

    const model = {
      supportsVision: false,
      supportsToolSearch: () => false,
      chat: async (_msgs: any[], options: any) => {
        options.onReasoningChunk?.(reasoningSample);
        options.onNativeAction?.({
          id: 'acp:todo-1',
          name: 'todowrite',
          status: 'completed',
          parameters: {
            todos: [
              { content: 'Scaffold horse-simulator project and vendor Three.js', status: 'in_progress' },
              { content: 'Build procedural horse model with articulated rig', status: 'pending' },
              { content: 'Preview, visually verify and fix issues', status: 'pending' }
            ]
          }
        });
        fs.writeFileSync(
          path.join(workspace, 'index.html'),
          '<!doctype html><html lang="en"><head><title>Stride</title></head><body><main><h1>Stride</h1></main></body></html>'
        );
        return {
          content: 'Completed Stride simulator.',
          externalActions: [
            { name: 'fs_read', status: 'completed', detail: path.join(workspace, 'index.html') }
          ],
          usage: { promptTokens: 50, completionTokens: 20 }
        };
      }
    };
    loop.initializeProvider = () => model as never;
    loop.llm = model as never;

    await loop.run();

    const planEvents = events.filter((e) => e.type === 'agent_plan');
    assert.equal(planEvents.length >= 2, true, 'must emit agent_plan from reasoning and then update from todowrite');
    assert.equal(latestSidebarPlan.length, 3);
    assert.equal(latestSidebarPlan[0]?.text, 'Scaffold horse-simulator project and vendor Three.js');

    const sidebarText = sessionSidebarRows(
      {
        title: 'Horse Simulator',
        cwd: workspace,
        provider: 'acp/opencode',
        model: 'deepseek-v4.1-flash',
        contextChars: 12000,
        contextLimit: 180000,
        plan: latestSidebarPlan
      },
      28
    )
      .map(stripAnsi)
      .join('\n');
    assert.equal(sidebarText.includes('Plan  '), true, 'sidebar must render Plan header');
    assert.equal(sidebarText.includes('Scaffold horse-simulator project'), true, 'sidebar must render plan steps');
  } finally {
    process.chdir(previousDirectory);
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
