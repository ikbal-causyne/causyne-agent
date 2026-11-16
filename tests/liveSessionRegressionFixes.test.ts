import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentLoop } from '../src/agentLoop.js';
import { loadConfig, saveConfig } from '../src/config.js';
import { getMemory, saveMemory } from '../src/memory.js';
import {
  formatMemoryContext,
  normalizeMemoryData,
  recordScopedFact
} from '../src/memory/scopedFacts.js';
import { WorkspacePerception } from '../src/perception.js';
import {
  extractKeywords,
  forgetPlans,
  lookupPlan,
  PLAN_FILE,
  recordPlan,
  toStep
} from '../src/planCache.js';
import { analyzeTask } from '../src/taskShape.js';
import { memoryWrite } from '../src/tools/memoryWrite.js';
import { routePacks, isReverseEngineeringIntent } from '../src/toolPacks.js';
import { determineToolScope } from '../src/smartToolsUse.js';
import { codeProgressFromAction } from '../src/tui/codeProgress.js';
import { CodeStreamRenderer } from '../src/tui/codeStreamRenderer.js';
import { Transcript } from '../src/tui/transcript.js';
import { stripAnsi } from '../src/tui/text.js';
import { CausyneBrowser } from '../src/browser/causyneBrowser.js';
import { StatusLine } from '../src/tui/statusLine.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

test('Android APK/AAB build prompts route to software_engineering and do not unlock reverse_engineering', () => {
  const buildPrompt = 'build newest aab from newest fresh bump version and also bump version name';
  assert.equal(isReverseEngineeringIntent(buildPrompt), false);
  assert.ok(!routePacks(buildPrompt).includes('reverse_engineering'));
  assert.equal(determineToolScope(buildPrompt).archetype, 'software_engineering');

  const exportApkPrompt = 'bump versionCode and export signed release app.apk for Play Store';
  assert.equal(isReverseEngineeringIntent(exportApkPrompt), false);
  assert.ok(!routePacks(exportApkPrompt).includes('reverse_engineering'));
  assert.equal(determineToolScope(exportApkPrompt).archetype, 'software_engineering');

  for (const rePrompt of [
    'inspect /tmp/app-release.aab manifest and permissions',
    'unpack sample.apk and extract assets',
    'analyze cn.wps.moffice_eng.apk using rea',
    'build clean-room android app from this package',
    'decompile libnative.so and inspect symbols'
  ]) {
    assert.equal(isReverseEngineeringIntent(rePrompt), true, `Expected RE intent for: ${rePrompt}`);
    assert.ok(routePacks(rePrompt).includes('reverse_engineering'), `Expected reverse_engineering pack for: ${rePrompt}`);
    assert.equal(determineToolScope(rePrompt).archetype, 'reverse_engineering');
  }
});

test('AgentLoop: sysRun mentioning stale workspace index.html on AAB build never triggers web verification or Anti-Slop', async () => {
  const workspace = makeTempDir('causyne-aab-nonweb-');
  fs.writeFileSync(path.join(workspace, 'index.html'), '<html><head><meta http-equiv="refresh" content="0;url=public/"></head></html>');
  fs.writeFileSync(path.join(workspace, 'project.godot'), 'config_version=5\n');

  const events: Array<Record<string, unknown>> = [];
  const ws = {
    readyState: 1,
    send: (raw: string) => {
      try { events.push(JSON.parse(raw) as Record<string, unknown>); } catch {}
    }
  };

  const prevConfig = loadConfig();
  saveConfig({
    ...prevConfig,
    provider: 'acp/opencode',
    model: 'deepseek-v4.1-flash-free',
    autonomyMode: 'C'
  });

  try {
    let chatCalls = 0;
    const loop = new AgentLoop(ws, 'task-aab-build', 'build newest aab from newest fresh bump version and also bump version name', {
      workspaceRoot: workspace
    });

    (loop as unknown as { initializeProvider: () => unknown }).initializeProvider = () => ({
      supportsVision: false,
      chat: async (_messages: unknown[], options: Record<string, any>) => {
        chatCalls++;
        options.onNativeAction?.({
          id: 'act-grep-1',
          name: 'sysRun',
          status: 'completed',
          detail: `grep -rn "0.7.17" ${path.join(workspace, 'index.html')} ${path.join(workspace, 'project.godot')}`,
          parameters: { command: 'grep -rn "0.7.17" index.html project.godot' }
        });
        return {
          content: 'Built release AAB at builds/android/release.aab (versionCode 29, versionName 0.7.18).',
          externalActions: [
            {
              id: 'act-grep-1',
              name: 'sysRun',
              status: 'completed',
              detail: `grep -rn "0.7.17" ${path.join(workspace, 'index.html')}`,
              parameters: { command: 'grep -rn "0.7.17" index.html' }
            }
          ],
          usage: {
            promptTokens: 53070,
            completionTokens: 420,
            measurement: 'provider_reported',
            measurementScope: 'last_model_call'
          }
        };
      }
    });

    await loop.run();

    assert.equal(chatCalls, 1, 'Expected single clean completion turn without false web guard retry');
    assert.equal(loop.hasWebSurfaceArtifacts(), false, 'Inspected HTML via sysRun grep must not mark webArtifacts');
    assert.equal(events.some(e => e.type === 'host_verification_scheduled'), false, 'Must not schedule browser verification on non-web AAB task');
    assert.equal(events.some(e => e.type === 'tool_call' && e.tool === 'browser_act'), false, 'Must not inject browser_act on AAB build');

    const usageEvent = events.filter(e => e.type === 'usage_update').at(-1);
    assert.ok(usageEvent, 'Expected usage_update event');
    assert.equal(usageEvent.contextLimitChars, 512000, 'Expected 128K token char limit for deepseek-v4.1-flash-free');
    assert.equal(usageEvent.contextChars, 53070 * 4, 'Expected ACP provider_reported promptTokens reflected in contextChars');

    const statusLine = new StatusLine().setSession({
      provider: 'acp/opencode',
      model: 'deepseek-v4.1-flash-free',
      cwd: workspace
    });
    statusLine.onUsage(usageEvent);
    const renderedStatus = stripAnsi(statusLine.renderIdle({ width: 120 }));
    assert.match(renderedStatus, /53(?:\.\d)?K \(41%\)/);
  } finally {
    saveConfig(prevConfig);
  }
});

test('AgentLoop: ACP externalActions does not replay already-applied todowrite plans on turn completion', async () => {
  const workspace = makeTempDir('causyne-plan-dedupe-');
  const events: Array<Record<string, unknown>> = [];
  const ws = {
    readyState: 1,
    send: (raw: string) => {
      try { events.push(JSON.parse(raw) as Record<string, unknown>); } catch {}
    }
  };

  const plan1 = [
    { id: '1', content: 'Bump version', status: 'in_progress' },
    { id: '2', content: 'Export AAB', status: 'pending' }
  ];
  const plan2 = [
    { id: '1', content: 'Bump version', status: 'completed' },
    { id: '2', content: 'Export AAB', status: 'completed' }
  ];

  const loop = new AgentLoop(ws, 'task-plan-dedupe', 'bump version and build bundle', {
    workspaceRoot: workspace
  });
  loop.config.provider = 'acp/opencode';
  loop.config.autonomyMode = 'C';

  (loop as unknown as { initializeProvider: () => unknown }).initializeProvider = () => ({
    supportsVision: false,
    chat: async (_messages: unknown[], options: Record<string, any>) => {
      options.onNativeAction?.({
        id: 'todo-1',
        name: 'todowrite',
        status: 'completed',
        parameters: { todos: plan1 }
      });
      options.onNativeAction?.({
        id: 'build-1',
        name: 'sysRun',
        status: 'completed',
        detail: './gradlew bundleRelease',
        parameters: { command: './gradlew bundleRelease' }
      });
      options.onNativeAction?.({
        id: 'todo-2',
        name: 'todowrite',
        status: 'completed',
        parameters: { todos: plan2 }
      });
      return {
        content: 'Completed version bump and build.',
        externalActions: [
          { id: 'todo-1', name: 'todowrite', status: 'completed', parameters: { todos: plan1 } },
          { id: 'build-1', name: 'sysRun', status: 'completed', detail: './gradlew bundleRelease', parameters: { command: './gradlew bundleRelease' } },
          { id: 'todo-2', name: 'todowrite', status: 'completed', parameters: { todos: plan2 } }
        ],
        usage: { promptTokens: 200, completionTokens: 50, measurement: 'provider_reported', measurementScope: 'last_model_call' }
      };
    }
  });

  await loop.run();

  const planEvents = events.filter(e => e.type === 'agent_plan');
  const lastCompletedCounts = planEvents.map(e =>
    Array.isArray(e.plan) ? e.plan.filter((item: any) => item.status === 'completed').length : -1
  );
  // Final state must never regress from 2 completed back to 0 (stale replay)
  assert.equal(lastCompletedCounts.at(-1), 2);
  const regressed = lastCompletedCounts.some((count, idx) => idx > 0 && count < (lastCompletedCounts[idx - 1] ?? 0));
  assert.equal(regressed, false, `Plan progress must not regress via stale replay: ${JSON.stringify(lastCompletedCounts)}`);
});

test('CodeStreamRenderer: preserves nativeStep executing activity on Responding and avoids duplicate transcript activity rows', () => {
  const transcript = new Transcript();
  const statusUpdates: string[] = [];
  const renderer = new CodeStreamRenderer({
    out: { columns: 120, rows: 35, isTTY: true, write: () => true },
    transcript,
    quietStatus: true,
    onStatusChange: (msg: string) => statusUpdates.push(msg)
  });

  renderer.resetTurn();
  renderer.handle({ type: 'agent_activity', activity: 'Analyzing & executing…' });
  renderer.handle({
    type: 'notice',
    nativeStep: true,
    actionName: 'sysRun',
    message: 'acp/opencode sysRun ./gradlew bundleRelease'
  });
  renderer.handle({ type: 'agent_activity', activity: 'Responding…' });
  renderer.handle({ type: 'agent_message', content: 'Done.', streaming: true });
  renderer.handle({ type: 'agent_message', content: 'Done.', streaming: false });

  assert.equal(statusUpdates.includes('Analyzing & executing…'), true);
  assert.equal(statusUpdates.includes('Responding…'), true);

  const activityNoticeFrames = transcript.frames.filter(f => f.meta?.activity === true);
  assert.equal(activityNoticeFrames.length, 0, 'quietStatus renderer must not litter transcript with transient activity notices');

  const reasoningFrame = transcript.frames.find(f => f.meta?.reasoning === true);
  assert.ok(reasoningFrame, 'Expected reasoning/activity frame for nativeStep sysRun');
  assert.equal(reasoningFrame.meta?.activity, 'executing', 'nativeStep sysRun box must keep executing activity instead of responding');
  const renderedBox = stripAnsi((reasoningFrame.rows || []).join('\n'));
  assert.doesNotMatch(renderedBox, /\bresponding\b/i);
});

test('CausyneBrowser: safePageTitle handles execution context destroyed during redirect cleanly', async () => {
  const workspace = makeTempDir('causyne-browser-title-redirect-');
  const htmlPath = path.join(workspace, 'index.html');
  fs.writeFileSync(htmlPath, '<!doctype html><meta http-equiv="refresh" content="0;url=public/">');

  let titleCalls = 0;
  let loadWaitCalls = 0;
  const fakePage = {
    currentUrl: 'about:blank',
    closed: false,
    isClosed() { return this.closed; },
    url() { return this.currentUrl; },
    async title() {
      titleCalls++;
      if (titleCalls === 1) {
        throw new Error('page.title: Execution context was destroyed, most likely because of a navigation');
      }
      return 'Redirected Target';
    },
    async goto(url: string) {
      this.currentUrl = url;
      return { status: () => 200, headers: () => ({ 'content-type': 'text/html' }) };
    },
    async waitForLoadState() {
      loadWaitCalls++;
    },
    async waitForTimeout() {},
    async waitForSelector() {},
    locator() { return { first: () => this }; },
    async evaluate() { return true; },
    async route() {},
    setDefaultTimeout() {},
    keyboard: { press: async () => {} },
    mouse: { wheel: async () => {} },
    async close() { this.closed = true; }
  };

  const session = {
    pages: () => [fakePage],
    newPage: async () => fakePage,
    close: async () => {}
  };

  const browser = new CausyneBrowser({
    workspace,
    profileDirectory: path.join(workspace, '.profile'),
    ensureBrowserCapability: async () => ({ ok: true }),
    resolveRuntime: () => ({
      installDirectory: '/fake/causyne-browser',
      resourceDirectory: '/fake/resources',
      source: 'environment'
    }),
    loadBrowserEngine: async () => ({ Camoufox: async () => session }),
    validateUrl: async (value: string) => new URL(value)
  });

  try {
    const results = await browser.run([{ type: 'preview', filePath: 'index.html' }], workspace);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.title, 'Redirected Target');
    assert.ok(loadWaitCalls >= 1, 'Expected waitForLoadState before retrying title');

    // Verify persistent navigation destruction falls back to empty title instead of throwing
    fakePage.title = async () => {
      throw new Error('page.title: Execution context was destroyed, most likely because of a navigation');
    };
    const res2 = await browser.run([{ type: 'switchTab' }], workspace);
    assert.equal(res2[0]?.title, '');
  } finally {
    await browser.close();
  }
});

test('scopedFacts & memoryWrite: scopes facts to workspace and filters unrelated projects and test junk', async () => {
  const gameRepo = makeTempDir('causyne-game-mem-');
  const otherRepo = makeTempDir('causyne-other-mem-');

  let store = normalizeMemoryData({
    facts: [
      'User prefers concise terminal answers',
      'Test fact for TUI composer integrity',
      'Built Project Alpha 3D experience in Three.js with vercel deploy',
      `Built Project Beta Portal in ${otherRepo} with Vite and React`,
      `Upgraded Game Demo in ${gameRepo} with NumPy 2.4.3 and Android release script`,
      'Android release uses ./scripts/build.sh android-bundle'
    ]
  });

  const rec = recordScopedFact(store, 'Godot 4.7.2 exports Android AAB from godot/', {
    workspace: gameRepo
  });
  store = rec.memory;
  assert.equal(rec.alreadyKnown, false);
  assert.equal(store.entries?.at(-1)?.workspace, gameRepo);

  const forGame = formatMemoryContext(store, { workspaceRoot: gameRepo });
  assert.match(forGame, /User prefers concise terminal answers/);
  assert.match(forGame, /Godot 4\.7\.2 exports Android AAB/);
  assert.match(forGame, /Upgraded Game Demo/);
  assert.doesNotMatch(forGame, /Test fact for TUI composer integrity/);
  assert.doesNotMatch(forGame, /Project Alpha 3D/);
  assert.doesNotMatch(forGame, /Project Beta Portal/);

  const forOther = formatMemoryContext(store, { workspaceRoot: otherRepo });
  assert.match(forOther, /User prefers concise terminal answers/);
  assert.match(forOther, /Project Beta Portal/);
  assert.doesNotMatch(forOther, /Game Demo/);
  assert.doesNotMatch(forOther, /Godot 4\.7\.2 exports Android AAB/);
  assert.doesNotMatch(forOther, /Project Alpha 3D/);

  const prevMemory = getMemory();
  try {
    saveMemory({ facts: [], entries: [] });
    const res = await memoryWrite.execute(
      { fact: 'Use release keystore for Play Store AAB' },
      { workspaceRoot: gameRepo }
    );
    assert.equal(res.success, true);
    const saved = getMemory();
    const entry = saved.entries?.find(e => e.text === 'Use release keystore for Play Store AAB');
    assert.ok(entry, 'Expected memoryWrite to store scoped entry');
    assert.equal(entry.workspace, gameRepo);
  } finally {
    saveMemory(prevMemory);
  }
});

test('WorkspacePerception, routePacks & analyzeTask: Godot + Android repo ignores legacy root index.html on non-web tasks', async () => {
  const repo = makeTempDir('causyne-game-shape-');
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'game-web-legacy', scripts: { dev: 'vite' } }));
  fs.writeFileSync(path.join(repo, 'index.html'), '<!doctype html><meta http-equiv="refresh" content="0;url=public/">');
  fs.mkdirSync(path.join(repo, 'godot'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'godot', 'project.godot'), 'config_version=5\n[application]\nconfig/name="GameDemo"\n');
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'docs', 'ANDROID_RELEASE.md'), '# Android Release\nUse scripts/build.sh android-bundle\n');
  fs.writeFileSync(path.join(repo, 'docs', 'ENGINEERING.md'), '# Architecture\nGodot 4.7.2\n');
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'scripts', 'build.sh'), '#!/bin/sh\necho build\n');

  const perception = new WorkspacePerception();
  const ctx = await perception.buildContext(repo);

  assert.ok(ctx.subprojectStacks.some(s => /godot/i.test(s)), `Expected godot stack in ${JSON.stringify(ctx.subprojectStacks)}`);
  assert.ok(ctx.docFiles.includes('docs/ANDROID_RELEASE.md'), `Expected ANDROID_RELEASE.md in ${JSON.stringify(ctx.docFiles)}`);
  assert.ok(ctx.docFiles.includes('docs/ENGINEERING.md'));
  assert.ok(ctx.buildFiles.includes('scripts/build.sh'), `Expected build.sh in ${JSON.stringify(ctx.buildFiles)}`);
  assert.ok(ctx.topEntries.some(e => /^docs\/?$/.test(e) || e === 'docs/'));
  assert.match(String(ctx.projectType || ''), /godot/i);

  const routingCtx = {
    framework: ctx.framework ? String(ctx.framework) : '',
    projectType: ctx.projectType || '',
    designSystem: ctx.designSystem ? ctx.designSystem.join(', ') : '',
    keyFiles: ctx.keyFiles,
    subprojectStacks: ctx.subprojectStacks,
    docFiles: ctx.docFiles,
    buildFiles: ctx.buildFiles
  };

  assert.deepEqual(routePacks('hi ', routingCtx), [], 'Greeting must not preload workspace packs');
  assert.equal(routePacks('build newest aab for release', routingCtx).includes('web'), false, 'Android AAB build must not preload web pack');
  assert.equal(routePacks('build newest aab for release', routingCtx).includes('reverse_engineering'), false);
  assert.ok(routePacks('fix the web export html page', routingCtx).includes('web'), 'Explicit web task in hybrid repo should still unlock web');

  const greetingShape = analyzeTask('hi ', routingCtx);
  assert.equal(greetingShape.archetype, 'research');
  assert.equal(greetingShape.packs.length, 0);

  const aabShape = analyzeTask('build newest aab and bump versionCode', routingCtx);
  assert.equal(aabShape.archetype, 'modify_repo');
  assert.ok(aabShape.phases[0]?.name.toLowerCase().includes('orient'), `Expected orient phase first: ${JSON.stringify(aabShape.phases)}`);
  assert.equal(aabShape.packs.some(p => p.name === 'web'), false, 'AEB/AAB shape must not include web pack');
  assert.ok(aabShape.packs.some(p => p.name === 'game'), 'Expected game pack from godot/ subproject');
});

test('AgentLoop: injects project docs/buildFiles, uses docs-first guidance, and excludes unrelated-workspace facts', async () => {
  const repo = makeTempDir('causyne-game-loop-');
  const otherRepo = makeTempDir('causyne-other-loop-');
  fs.writeFileSync(path.join(repo, 'index.html'), '<html></html>');
  fs.mkdirSync(path.join(repo, 'godot'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'godot', 'project.godot'), 'config_version=5\n');
  fs.mkdirSync(path.join(repo, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'docs', 'ANDROID_RELEASE.md'), '# Release guide\n');
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'scripts', 'build.sh'), '#!/bin/sh\n');

  const events: Array<Record<string, unknown>> = [];
  const ws = {
    readyState: 1,
    send: (raw: string) => {
      try { events.push(JSON.parse(raw) as Record<string, unknown>); } catch {}
    }
  };
  const prevMemory = getMemory();
  const prevConfig = loadConfig();

  saveMemory({
    facts: [
      `Built Project Alpha 3D in ${otherRepo} with Vite`,
      `Release builds for this repo live in ${repo}/scripts/build.sh`
    ],
    entries: [
      { text: `Built Project Alpha 3D in ${otherRepo} with Vite`, workspace: otherRepo },
      { text: `Release builds for this repo live in ${repo}/scripts/build.sh`, workspace: repo }
    ]
  });
  saveConfig({
    ...prevConfig,
    provider: 'acp/opencode',
    model: 'deepseek-v4.1-flash-free',
    autonomyMode: 'C'
  });

  try {
    let chatCalls = 0;
    let capturedSystem = '';
    const loop = new AgentLoop(ws, 'task-grounding-check', 'build newest android aab release', {
      workspaceRoot: repo
    });
    (loop as unknown as { initializeProvider: () => unknown }).initializeProvider = () => ({
      supportsVision: false,
      chat: async (messages: Array<{ role: string; content: string }>, options: Record<string, any>) => {
        chatCalls++;
        capturedSystem = messages
          .filter(m => m.role === 'system')
          .map(m => String(m.content || ''))
          .join('\n\n');
        options.onNativeAction?.({
          id: 'build-1',
          name: 'sysRun',
          status: 'completed',
          detail: './scripts/build.sh android-bundle',
          parameters: { command: './scripts/build.sh android-bundle' }
        });
        return {
          content: 'Built release bundle via scripts/build.sh.',
          externalActions: [
            {
              id: 'build-1',
              name: 'sysRun',
              status: 'completed',
              detail: './scripts/build.sh android-bundle',
              parameters: { command: './scripts/build.sh android-bundle' }
            }
          ]
        };
      }
    });

    await loop.run();

    assert.equal(events.some(e => e.type === 'step_error'), false, 'Missing provider usage must not emit step_error');
    assert.equal(chatCalls, 1, 'Missing provider usage must not crash post-response accounting or spin retry 1/3');
    assert.doesNotMatch(capturedSystem, /DO NOT perform exploratory directory listings/i);
    assert.match(capturedSystem, /docs\/ANDROID_RELEASE\.md/);
    assert.match(capturedSystem, /scripts\/build\.sh/);
    assert.match(capturedSystem, /Release builds for this repo live in/);
    assert.doesNotMatch(capturedSystem, /Project Alpha 3D/);
  } finally {
    saveMemory(prevMemory);
    saveConfig(prevConfig);
  }
});

test('planCache: rejects 1-word and low-signal typo templates even if persisted on disk', () => {
  forgetPlans();
  try {
    assert.equal(
      recordPlan({
        prompt: 'test',
        archetype: 'build_app',
        steps: [toStep('browser_act', { action: 'goto' }, true), toStep('browser_act', { action: 'shot' }, true)]
      }),
      null
    );
    assert.equal(
      recordPlan({
        prompt: 'fix pleae',
        archetype: 'build_app',
        steps: [toStep('browser_act', { action: 'goto' }, true), toStep('browser_act', { action: 'shot' }, true)]
      }),
      null
    );

    // Simulate legacy noisy plans/index.json on disk and confirm lookupPlan refuses to match them.
    fs.mkdirSync(path.dirname(PLAN_FILE), { recursive: true });
    fs.writeFileSync(
      PLAN_FILE,
      JSON.stringify({
        version: 1,
        plans: [
          {
            id: 'legacy-noise-1',
            archetype: 'build_app',
            keywords: ['test'],
            steps: [{ tool: 'browser_act', note: 'goto', ok: true }, { tool: 'browser_act', note: 'shot', ok: true }],
            uses: 1,
            wins: 1,
            createdAt: Date.now(),
            updatedAt: Date.now()
          },
          {
            id: 'legacy-noise-2',
            archetype: 'build_app',
            keywords: ['fix', 'pleae'],
            steps: [{ tool: 'browser_act', note: 'goto', ok: true }, { tool: 'browser_act', note: 'shot', ok: true }],
            uses: 1,
            wins: 1,
            createdAt: Date.now(),
            updatedAt: Date.now()
          }
        ]
      })
    );

    assert.equal(lookupPlan({ prompt: 'test', archetype: 'build_app' }), null);
    assert.equal(lookupPlan({ prompt: 'fix pleae', archetype: 'build_app' }), null);
    assert.equal(lookupPlan({ prompt: 'fix aab', archetype: 'build_app' }), null);

    // Real domain-specific multi-keyword plans still cache & retrieve cleanly.
    assert.ok(extractKeywords('compile android release bundle').length >= 3);
    const valid = recordPlan({
      prompt: 'compile android release bundle',
      archetype: 'modify_repo',
      steps: [toStep('fs_read', {}, true), toStep('sys_run', { action: 'gradle' }, true)]
    });
    assert.ok(valid);
    const hit = lookupPlan({ prompt: 'compile android release bundle', archetype: 'modify_repo' });
    assert.ok(hit);
    assert.equal(hit.matchType, 'exact');
  } finally {
    forgetPlans();
  }
});

test('codeProgressFromAction: maps raw ACP/native file mutation tool names', () => {
  for (const [tool, expectedVerb] of [
    ['write', 'Creating'],
    ['edit', 'Editing'],
    ['multiedit', 'Editing'],
    ['multi_edit', 'Editing'],
    ['write_to_file', 'Creating'],
    ['WriteToFile', 'Creating']
  ] as const) {
    const ev = codeProgressFromAction(tool, { file_path: 'src/app.ts', content: 'export const x = 1;' }, `id-${tool}`);
    assert.ok(ev, `Expected codeProgressFromAction to map tool ${tool}`);
    assert.equal(ev.operation, expectedVerb);
    assert.equal(ev.description, `${expectedVerb} app.ts`);
  }
});
