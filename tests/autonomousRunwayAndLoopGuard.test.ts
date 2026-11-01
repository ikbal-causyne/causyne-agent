import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AntigravityProvider,
  isNativeMutation,
  nativeToolSignature,
  detectNativeCycle
} from '../src/providers/antigravity.js';
import { UnifiedBudgetEnforcer, EfficiencyCheckpoint } from '../src/providers/budgetEnforcer.js';

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

test('UnifiedBudgetEnforcer recordAction throws action-scoped checkpoint', () => {
  const enforcer = new UnifiedBudgetEnforcer(100_000, 5);
  for (let i = 0; i < 5; i++) {
    enforcer.recordAction(`act-${i}`);
  }
  assert.throws(
    () => enforcer.recordAction('act-6'),
    (error: unknown) => {
      assert.ok(error instanceof EfficiencyCheckpoint);
      assert.equal((error as EfficiencyCheckpoint).reason, 'actions');
      assert.equal((error as EfficiencyCheckpoint).scope, 'task');
      return true;
    }
  );
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

test('autonomous runway: TokenTracker and UnifiedBudgetEnforcer dynamically expand runways', async () => {
  const { TokenTracker } = await import('../src/tokenTracker.js');
  const { UnifiedBudgetEnforcer } = await import('../src/providers/budgetEnforcer.js');

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

  // Test UnifiedBudgetEnforcer dynamic momentum extension
  const enforcer = new UnifiedBudgetEnforcer(100_000, 35);
  for (let i = 0; i < 35; i++) {
    enforcer.recordAction(`action_${i}`);
  }
  assert.equal(enforcer.getRemainingActions(), 0);

  // Extend for autonomous momentum (+50 actions)
  enforcer.extendForAutonomousMomentum(50, 500_000);
  assert.equal(enforcer.getRemainingActions(), 50);
  // Can now record further actions without throwing
  enforcer.recordAction('action_36');
  assert.equal(enforcer.getRemainingActions(), 49);
});
