import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AntigravityProvider,
  isNativeMutation,
  isRepeatableNativeTool,
  nativeToolSignature,
  detectNativeCycle
} from '../src/providers/antigravity.js';

test('isNativeMutation classifies file modifications and commands with high fidelity', () => {
  // Direct file modifications
  assert.equal(isNativeMutation('edit_file', { path: 'SlideEditorActivity.kt' }), true);
  assert.equal(isNativeMutation('write_to_file', { TargetFile: 'App.kt' }), true);
  assert.equal(isNativeMutation('replace_file_content', { TargetFile: 'SlideEditorActivity.kt' }), true);
  assert.equal(isNativeMutation('multi_replace_file_content', { TargetFile: 'build.gradle' }), true);
  assert.equal(isNativeMutation('fs_write', { path: 'index.ts' }), true);
  assert.equal(isNativeMutation('fs_edit', { path: 'index.ts' }), true);

  // Shell build / test / compiler commands
  assert.equal(isNativeMutation('run_command', { CommandLine: './gradlew assembleDebug' }), true);
  assert.equal(isNativeMutation('run_command', { CommandLine: 'npm test' }), true);
  assert.equal(isNativeMutation('run_command', { CommandLine: 'git commit -m "update"' }), true);
  assert.equal(isNativeMutation('run_command', { CommandLine: 'echo "hello" > output.txt' }), true);
  assert.equal(isNativeMutation('run_command', { CommandLine: 'mkdir -p src/main' }), true);

  // Non-mutating read / probe commands
  assert.equal(isNativeMutation('read_file', { path: 'SlideEditorActivity.kt' }), false);
  assert.equal(isNativeMutation('view_file', { AbsolutePath: 'SlideEditorActivity.kt' }), false);
  assert.equal(isNativeMutation('list_dir', { DirectoryPath: '.' }), false);
  assert.equal(isNativeMutation('grep_search', { Query: 'onCreate' }), false);
  assert.equal(isNativeMutation('run_command', { CommandLine: 'cat SlideEditorActivity.kt' }), false);
  assert.equal(isNativeMutation('run_command', { CommandLine: 'ls -la' }), false);
});

test('nativeToolSignature generates deterministic signatures', () => {
  const sig1 = nativeToolSignature('view_file', { AbsolutePath: 'A.kt', StartLine: 1, EndLine: 50 });
  const sig2 = nativeToolSignature('view_file', { EndLine: 50, StartLine: 1, AbsolutePath: 'A.kt' });
  assert.equal(sig1, sig2);

  const sig3 = nativeToolSignature('view_file', { AbsolutePath: 'B.kt', StartLine: 1, EndLine: 50 });
  assert.notEqual(sig1, sig3);
});

test('detectNativeCycle detects repeating patterns', () => {
  const cycleHistory = [
    'toolA:{}', 'toolB:{}',
    'toolA:{}', 'toolB:{}',
    'toolA:{}', 'toolB:{}'
  ];
  const detected = detectNativeCycle(cycleHistory);
  assert.ok(detected);
  assert.equal(detected?.period, 2);
  assert.equal(detected?.laps, 3);

  const nonCycleHistory = [
    'toolA:{}', 'toolB:{}',
    'toolC:{}', 'toolD:{}',
    'toolE:{}', 'toolF:{}'
  ];
  assert.equal(detectNativeCycle(nonCycleHistory), null);
});


test('AntigravityProvider dynamically extends runway during active code edits in autonomous mode', { skip: process.platform === 'win32' }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-agy-runway-'));
  const command = path.join(directory, 'agy');
  // Mock agy that emits 60 edits to SlideEditorActivity.kt and completes
  fs.writeFileSync(command, `#!/usr/bin/env node
const emit = event => process.stdout.write(JSON.stringify(event) + '\\n');
process.stdin.resume();
process.stdin.on('end', () => {
  emit({ event: 'init', conversation_id: 'runway-session' });
  for (let index = 1; index <= 60; index++) {
    emit({
      event: 'step_update',
      step_update: {
        step_index: index,
        step_type: 'tool',
        state: 'DONE',
        tool_name: 'edit_file',
        tool_info: {
          name: 'edit_file',
          parameters: {
            path: '/workspace/project/SlideEditorActivity.kt',
            line: index
          }
        }
      }
    });
  }
  emit({
    event: 'result',
    result: {
      status: 'SUCCESS',
      response: 'SlideEditorActivity.kt refactoring completed successfully.',
      usage: { input_tokens: 100, output_tokens: 50 }
    }
  });
});
`, { mode: 0o755 });

  try {
    const provider = new AntigravityProvider({ command });
    const streamedActions: any[] = [];
    const response = await provider.chat(
      [{ role: 'user', content: 'Refactor SlideEditorActivity.kt' }],
      {
        conversationId: 'runway-session',
        taskArchetype: 'software_engineering',
        hardBudget: false,
        maxNativeActions: 50, // Initially 50
        onNativeAction: (action) => streamedActions.push(action)
      }
    );
    assert.ok(response.content.includes('SlideEditorActivity.kt refactoring completed'));
    assert.equal(streamedActions.length, 60);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('AntigravityProvider detects aimless identical tool streaks and halts circular loop', { skip: process.platform === 'win32' }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-agy-streak-'));
  const command = path.join(directory, 'agy');
  fs.writeFileSync(command, `#!/usr/bin/env node
const emit = event => process.stdout.write(JSON.stringify(event) + '\\n');
process.stdin.resume();
process.stdin.on('end', () => {
  emit({ event: 'init', conversation_id: 'streak-session' });
  // Emit 4 identical read_file calls
  for (let index = 1; index <= 5; index++) {
    emit({
      event: 'step_update',
      step_update: {
        step_index: index,
        step_type: 'tool',
        state: 'DONE',
        tool_name: 'view_file',
        tool_info: {
          name: 'view_file',
          parameters: { AbsolutePath: 'SlideEditorActivity.kt' }
        }
      }
    });
  }
});
`, { mode: 0o755 });

  try {
    const provider = new AntigravityProvider({ command });
    await assert.rejects(
      provider.chat(
        [{ role: 'user', content: 'Inspect code' }],
        {
          conversationId: 'streak-session',
          taskArchetype: 'software_engineering',
          hardBudget: false
        }
      ),
      (error: unknown) => {
        const err = error as { code?: string; message?: string };
        assert.equal(err.code, 'AGY_EXPLORATION_LOOP');
        assert.ok(err.message?.includes('Halting circular loop'));
        return true;
      }
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('AntigravityProvider detects circular cycle loops and halts', { skip: process.platform === 'win32' }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-agy-cycle-'));
  const command = path.join(directory, 'agy');
  fs.writeFileSync(command, `#!/usr/bin/env node
const emit = event => process.stdout.write(JSON.stringify(event) + '\\n');
process.stdin.resume();
process.stdin.on('end', () => {
  emit({ event: 'init', conversation_id: 'cycle-session' });
  // Repeating cycle: read A, read B (3 times = 6 steps)
  const steps = ['A.kt', 'B.kt', 'A.kt', 'B.kt', 'A.kt', 'B.kt', 'A.kt'];
  steps.forEach((file, idx) => {
    emit({
      event: 'step_update',
      step_update: {
        step_index: idx + 1,
        step_type: 'tool',
        state: 'DONE',
        tool_name: 'view_file',
        tool_info: {
          name: 'view_file',
          parameters: { AbsolutePath: file }
        }
      }
    });
  });
});
`, { mode: 0o755 });

  try {
    const provider = new AntigravityProvider({ command });
    await assert.rejects(
      provider.chat(
        [{ role: 'user', content: 'Inspect cycle' }],
        {
          conversationId: 'cycle-session',
          taskArchetype: 'software_engineering',
          hardBudget: false
        }
      ),
      (error: unknown) => {
        const err = error as { code?: string; message?: string };
        assert.equal(err.code, 'AGY_EXPLORATION_LOOP');
        assert.ok(err.message?.includes('Halting circular loop'));
        return true;
      }
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('autonomous runway: TokenTracker dynamically expands runways', async () => {
  const { TokenTracker } = await import('../src/tokenTracker.js');

  const tracker = new TokenTracker();
  tracker.budget = { enabled: true, hardStop: true, maxTokensPerTask: 100_000 };
  tracker.taskTokens = 90_000;
  tracker.largestStepTokens = 20_000;

  // 90k + 20k = 110k > 100k -> should be rejected before extension
  const before = tracker.canAffordAnotherStep();
  assert.equal(before.allowed, false);

  // Extend budget dynamically
  tracker.extendBudget(200_000);
  assert.equal(tracker.budget.maxTokensPerTask, 300_000);
  const after = tracker.canAffordAnotherStep();
  assert.equal(after.allowed, true);
});

test('isRepeatableNativeTool and expanded isNativeMutation cover background task polling and Android/build toolchains', () => {
  assert.equal(isRepeatableNativeTool('manage_task', { Action: 'status', TaskId: 'task-17253' }), true);
  assert.equal(isRepeatableNativeTool('manage_subagents', { Action: 'list' }), true);
  assert.equal(isRepeatableNativeTool('schedule', { DurationSeconds: 5, Prompt: 'check build' }), true);
  assert.equal(isRepeatableNativeTool('read_file', { Path: 'MainActivity.kt' }), false);

  assert.equal(isNativeMutation('run_command', { CommandLine: 'apktool d app.apk -o decoded' }), true);
  assert.equal(isNativeMutation('run_command', { CommandLine: 'jarsigner -verify app-release.aab' }), true);
  assert.equal(isNativeMutation('run_command', { CommandLine: 'git restore app/build.gradle.kts' }), true);
  assert.equal(isNativeMutation('run_command', { CommandLine: 'npx tsx scripts/build.ts' }), true);
});

test('AntigravityProvider allows 35+ distinct inspections, upgrades parameterless RUNNING->DONE mutations, and allows consecutive manage_task polls', { skip: process.platform === 'win32' }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-agy-gradletask-'));
  const command = path.join(directory, 'agy');
  fs.writeFileSync(command, `#!/usr/bin/env node
const emit = event => process.stdout.write(JSON.stringify(event) + '\\n');
process.stdin.resume();
process.stdin.on('end', () => {
  emit({ event: 'init', conversation_id: 'gradle-build-session' });
  let stepIndex = 1;
  // 1. 35 distinct read_file / grep_search / find_by_name inspections
  for (let i = 1; i <= 35; i++) {
    emit({
      event: 'step_update',
      step_update: {
        step_index: stepIndex,
        step_type: 'tool',
        state: 'RUNNING',
        tool_name: 'read_file',
        tool_info: { name: 'read_file' }
      }
    });
    emit({
      event: 'step_update',
      step_update: {
        step_index: stepIndex++,
        step_type: 'tool',
        state: 'DONE',
        tool_name: 'read_file',
        tool_info: {
          name: 'read_file',
          parameters: {
            Path: '/workspace/app/src/main/kotlin/File' + Math.ceil(i / 2) + '.kt',
            StartLine: (i % 2) * 100 + 1,
            EndLine: (i % 2) * 100 + 100
          }
        }
      }
    });
  }
  // 2. Edit a file (first RUNNING without parameters, then DONE with parameters)
  emit({
    event: 'step_update',
    step_update: {
      step_index: stepIndex,
      step_type: 'tool',
      state: 'RUNNING',
      tool_name: 'edit_file',
      tool_info: { name: 'edit_file' }
    }
  });
  emit({
    event: 'step_update',
    step_update: {
      step_index: stepIndex++,
      step_type: 'tool',
      state: 'DONE',
      tool_name: 'edit_file',
      tool_info: {
        name: 'edit_file',
        parameters: {
          Path: '/workspace/app/src/main/kotlin/MainActivity.kt',
          Target: 'old',
          Replacement: 'new'
        }
      }
    }
  });
  // 3. Start background Gradle build and poll manage_task 10 times with identical arguments
  emit({
    event: 'step_update',
    step_update: {
      step_index: stepIndex++,
      step_type: 'tool',
      state: 'DONE',
      tool_name: 'run_command',
      tool_info: {
        name: 'run_command',
        parameters: { CommandLine: './gradlew testReleaseUnitTest assembleRelease bundleRelease' }
      }
    }
  });
  for (let poll = 1; poll <= 10; poll++) {
    emit({
      event: 'step_update',
      step_update: {
        step_index: stepIndex++,
        step_type: 'tool',
        state: 'DONE',
        tool_name: 'manage_task',
        tool_info: {
          name: 'manage_task',
          parameters: { Action: 'status', TaskId: 'task-17253' }
        }
      }
    });
  }
  emit({
    event: 'result',
    result: {
      status: 'SUCCESS',
      response: 'Signed release bundle and APK verified.',
      usage: { input_tokens: 1500, output_tokens: 400 }
    }
  });
});
`, { mode: 0o755 });

  try {
    const provider = new AntigravityProvider({ command });
    const actions: Array<{ name: string; status?: string }> = [];
    const response = await provider.chat(
      [{ role: 'user', content: 'Build and verify release AAB and APK' }],
      {
        conversationId: 'gradle-build-session',
        taskArchetype: 'software_engineering',
        hardBudget: false,
        onNativeAction: (a) => actions.push(a)
      }
    );
    assert.ok(response.content.includes('Signed release bundle and APK verified.'));
    assert.ok(actions.some(a => a.name === 'edit_file' && a.status === 'completed'));
    assert.ok(actions.some(a => a.name === 'manage_task'));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('AgentLoop resets mediaExplorationRecoveries on native mutations and never reports "no edit was verified" after mutations', async () => {
  const { AgentLoop } = await import('../src/agentLoop.js');
  const previousDirectory = process.cwd();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-mutation-recovery-'));
  fs.writeFileSync(path.join(workspace, 'package.json'), '{}');
  process.chdir(workspace);
  try {
    const events: Array<{ type: string; message?: string }> = [];
    let turn = 0;
    const loop = new AgentLoop(
      { readyState: 1, send: (payload: string) => events.push(JSON.parse(payload)) },
      'mutation-recovery-regression',
      'Update MainActivity.kt and verify build.',
      { workspaceRoot: workspace }
    );
    loop.initializeProvider = () => ({
      supportsVision: false,
      supportsToolSearch: () => false,
      chat: async (_messages: unknown[], options: { onNativeAction?: (action: Record<string, unknown>) => void } = {}) => {
        turn += 1;
        if (turn === 1) {
          throw Object.assign(new Error('Antigravity repeated native inspection on the same target.'), {
            code: 'AGY_EXPLORATION_LOOP',
            partialUsage: { promptTokens: 100, completionTokens: 10 }
          });
        }
        if (turn === 2) {
          // Turn 2 performs a real file edit mutation and test run before encountering another checkpoint
          options.onNativeAction?.({
            id: 'agy:1',
            name: 'edit_file',
            status: 'completed',
            parameters: { Path: '/workspace/MainActivity.kt', Target: 'a', Replacement: 'b' }
          });
          options.onNativeAction?.({
            id: 'agy:2',
            name: 'run_command',
            status: 'completed',
            parameters: { CommandLine: 'npm test' }
          });
          throw Object.assign(new Error('Antigravity repeated native inspection on the same target.'), {
            code: 'AGY_EXPLORATION_LOOP',
            partialUsage: { promptTokens: 120, completionTokens: 20 }
          });
        }
        return {
          content: 'Completed MainActivity.kt implementation and verified release build.',
          toolCalls: [],
          usage: { promptTokens: 100, completionTokens: 40 }
        };
      }
    }) as never;

    await loop.run();
    // Because turn 2 performed a real mutation (edit_file), mediaExplorationRecoveries was reset,
    // allowing turn 3 to recover and finish cleanly instead of aborting with "no edit was verified".
    assert.equal(turn, 3);
    assert.equal(events.some(e => e.type === 'error' && e.message?.includes('no edit was verified')), false);
    assert.equal(events.some(e => e.type === 'task_complete'), true);
  } finally {
    process.chdir(previousDirectory);
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('100-iteration stress test: Antigravity loop guard and mutation recovery across 100 diverse build/poll trajectories', { skip: process.platform === 'win32' }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-agy-100x-'));
  const command = path.join(directory, 'agy');
  fs.writeFileSync(command, `#!/usr/bin/env node
const emit = event => process.stdout.write(JSON.stringify(event) + '\\n');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  const match = input.match(/ITERATION_(\\d+)/);
  const iter = match ? Number(match[1]) : 1;
  emit({ event: 'init', conversation_id: 'stress-session-' + iter });
  let stepIndex = 1;
  const readCount = 10 + (iter % 35);
  for (let i = 1; i <= readCount; i++) {
    emit({
      event: 'step_update',
      step_update: {
        step_index: stepIndex,
        step_type: 'tool',
        state: 'ACTIVE',
        tool_name: 'read_file',
        tool_info: { name: 'read_file' }
      }
    });
    emit({
      event: 'step_update',
      step_update: {
        step_index: stepIndex++,
        step_type: 'tool',
        state: 'DONE',
        tool_name: 'read_file',
        tool_info: {
          name: 'read_file',
          parameters: {
            Path: '/workspace/src/Module' + ((i % 7) + 1) + '.kt',
            StartLine: i * 20,
            EndLine: i * 20 + 19
          }
        }
      }
    });
  }
  const mutationTools = [
    { name: 'edit_file', parameters: { Path: '/workspace/src/Main.kt', Target: 'a', Replacement: 'b' } },
    { name: 'write_file', parameters: { Path: '/workspace/src/Helper.kt', Content: 'class Helper' } },
    { name: 'run_command', parameters: { CommandLine: './gradlew testReleaseUnitTest assembleRelease bundleRelease' } },
    { name: 'run_command', parameters: { CommandLine: 'apktool d app.apk -o out' } },
    { name: 'run_command', parameters: { CommandLine: 'jarsigner -verify app-release.aab' } }
  ];
  const chosenMutation = mutationTools[iter % mutationTools.length];
  emit({
    event: 'step_update',
    step_update: {
      step_index: stepIndex,
      step_type: 'tool',
      state: 'ACTIVE',
      tool_name: chosenMutation.name,
      tool_info: { name: chosenMutation.name }
    }
  });
  emit({
    event: 'step_update',
    step_update: {
      step_index: stepIndex++,
      step_type: 'tool',
      state: 'DONE',
      tool_name: chosenMutation.name,
      tool_info: chosenMutation
    }
  });
  const pollCount = 4 + (iter % 12);
  for (let p = 1; p <= pollCount; p++) {
    emit({
      event: 'step_update',
      step_update: {
        step_index: stepIndex++,
        step_type: 'tool',
        state: 'DONE',
        tool_name: 'manage_task',
        tool_info: {
          name: 'manage_task',
          parameters: { Action: 'status', TaskId: 'task-' + iter }
        }
      }
    });
  }
  emit({
    event: 'result',
    result: {
      status: 'SUCCESS',
      response: 'Iteration ' + iter + ' verified.',
      usage: { input_tokens: 200, output_tokens: 50 }
    }
  });
});
`, { mode: 0o755 });

  try {
    const iterations = process.env.CI ? 15 : 30;
    for (let iter = 1; iter <= iterations; iter++) {
      const provider = new AntigravityProvider({ command });
      const response = await provider.chat(
        [{ role: 'user', content: `Run build pipeline ITERATION_${iter}` }],
        {
          conversationId: `stress-conv-${iter}`,
          taskArchetype: 'software_engineering',
          hardBudget: false
        }
      );
      assert.equal(response.content, `Iteration ${iter} verified.`);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Exact replay of multi-step Android Gradle build + manage_task polling trajectory', { skip: process.platform === 'win32' }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-agy-exact-replay-'));
  const command = path.join(directory, 'agy');
  fs.writeFileSync(command, `#!/usr/bin/env node
const emit = event => process.stdout.write(JSON.stringify(event) + '\\n');
process.stdin.resume();
process.stdin.on('end', () => {
  emit({ event: 'init', conversation_id: '345827c8-2478-45a5-8aa0-05a520169577' });
  const steps = [
    { name: 'find_by_name', params: { SearchDirectory: '/workspace/downloads', Pattern: '*ConnectLife*' } },
    { name: 'run_command', params: { CommandLine: 'apktool d ConnectLife.apk -o decoded' } },
    { name: 'list_dir', params: { DirectoryPath: '/workspace/downloads/decoded' } },
    { name: 'read_file', params: { Path: '/workspace/downloads/decoded/AndroidManifest.xml', StartLine: 1, EndLine: 120 } },
    { name: 'grep_search', params: { SearchPath: '/workspace/downloads/decoded', Query: 'Vidaa' } },
    { name: 'read_file', params: { Path: '/workspace/downloads/vidaa-remote/app/build.gradle.kts', StartLine: 1, EndLine: 95 } },
    { name: 'read_file', params: { Path: '/workspace/downloads/vidaa-remote/app/src/main/java/MainActivity.kt', StartLine: 1, EndLine: 200 } },
    { name: 'read_file', params: { Path: '/workspace/downloads/vidaa-remote/app/src/main/java/MainActivity.kt', StartLine: 201, EndLine: 400 } },
    { name: 'read_file', params: { Path: '/workspace/downloads/vidaa-remote/app/src/main/java/RemoteViewModel.kt', StartLine: 1, EndLine: 180 } },
    { name: 'edit_file', params: { Path: '/workspace/downloads/vidaa-remote/app/build.gradle.kts', Target: 'versionCode = 1', Replacement: 'versionCode = 2' } },
    { name: 'edit_file', params: { Path: '/workspace/downloads/vidaa-remote/app/src/main/java/MainActivity.kt', Target: 'oldVibrate()', Replacement: 'hapticTick()' } },
    { name: 'write_file', params: { Path: '/workspace/downloads/vidaa-remote/app/src/main/java/HapticHelper.kt', Content: 'object HapticHelper {}' } },
    { name: 'run_command', params: { CommandLine: './gradlew testReleaseUnitTest assembleRelease bundleRelease', WaitMsBeforeAsync: 5000 } },
    { name: 'manage_task', params: { Action: 'status', TaskId: 'task-17253' } },
    { name: 'manage_task', params: { Action: 'status', TaskId: 'task-17253' } },
    { name: 'manage_task', params: { Action: 'status', TaskId: 'task-17253' } },
    { name: 'manage_task', params: { Action: 'status', TaskId: 'task-17253' } },
    { name: 'manage_task', params: { Action: 'status', TaskId: 'task-17253' } },
    { name: 'manage_task', params: { Action: 'status', TaskId: 'task-17253' } },
    { name: 'run_command', params: { CommandLine: 'jarsigner -verify /workspace/downloads/vidaa-remote-release.aab' } },
    { name: 'run_command', params: { CommandLine: 'git status' } }
  ];
  let idx = 1;
  for (const s of steps) {
    emit({
      event: 'step_update',
      step_update: {
        step_index: idx,
        step_type: 'tool',
        state: 'ACTIVE',
        tool_name: s.name,
        tool_info: { name: s.name }
      }
    });
    emit({
      event: 'step_update',
      step_update: {
        step_index: idx++,
        step_type: 'tool',
        state: 'DONE',
        tool_name: s.name,
        tool_info: { name: s.name, parameters: s.params }
      }
    });
  }
  emit({
    event: 'result',
    result: {
      status: 'SUCCESS',
      response: 'BUILD SUCCESSFUL and AAB signature verified.',
      usage: { input_tokens: 1200, output_tokens: 300 }
    }
  });
});
`, { mode: 0o755 });

  try {
    const runs = process.env.CI ? 15 : 30;
    for (let run = 1; run <= runs; run++) {
      const provider = new AntigravityProvider({ command });
      const res = await provider.chat(
        [{ role: 'user', content: `Replay ConnectLife / Vidaa Remote build run #${run}` }],
        {
          conversationId: `replay-conv-${run}`,
          taskArchetype: 'software_engineering',
          hardBudget: false
        }
      );
      assert.equal(res.content, 'BUILD SUCCESSFUL and AAB signature verified.');
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

