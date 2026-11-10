import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  resolveTaskTokenCeiling,
  peerCallTokenCeiling,
  peerNativeActionCeiling,
  isTerminalBudgetFailure,
  desktopDeadline,
  remainingDesktopTime,
  shouldRetryPeerError,
  hasBillablePartialUsage,
  DEFAULT_AGY_TASK_TOKENS,
  DEFAULT_AGY_CALL_TOKENS,
  DEFAULT_DESKTOP_NATIVE_ACTIONS,
  DEFAULT_AGY_NATIVE_ACTIONS,
  DESKTOP_TASK_WALL_MS
} from '../src/budget/budgetPolicy.js';
import { AntigravityProvider } from '../src/providers/antigravity.js';
import { TokenTracker } from '../src/tokenTracker.js';

describe('Hard Budget Enforcement Verification Matrix (Mode C, Antigravity, Wall-clock, Turn Resets)', () => {

  test('Autonomy mode C cannot bypass token limits (no 1M token auto-extension)', () => {
    // Mode C sets hardBudget=false, but resolveTaskTokenCeiling provides a finite ceiling
    const defaultCeiling = resolveTaskTokenCeiling({ provider: 'antigravity' });
    assert.equal(defaultCeiling, DEFAULT_AGY_TASK_TOKENS);
    assert.equal(defaultCeiling, 80_000);

    const callCeiling = peerCallTokenCeiling(undefined);
    assert.equal(callCeiling, DEFAULT_AGY_CALL_TOKENS);
    assert.equal(callCeiling, 32_000);

    // Verify all budget stops are terminal in mode C
    const terminalErrors = [
      'TASK_TOKEN_BUDGET',
      'PROVIDER_TOKEN_BUDGET',
      'AGY_DESKTOP_TASK_LIMIT',
      'AGY_TOKEN_BUDGET',
      'AGY_NATIVE_ACTION_BUDGET',
      'AGY_TASK_DEADLINE',
      'TASK_WALL_BUDGET'
    ];
    for (const code of terminalErrors) {
      assert.equal(isTerminalBudgetFailure({ code }), true);
      assert.equal(shouldRetryPeerError({ code }), false);
    }
  });

  test('Autonomy mode C cannot bypass native-action limits', () => {
    // Desktop tasks strictly cap at 12 actions even if configured high or in mode C
    assert.equal(peerNativeActionCeiling(100, true), DEFAULT_DESKTOP_NATIVE_ACTIONS);
    assert.equal(peerNativeActionCeiling(Infinity, true), DEFAULT_DESKTOP_NATIVE_ACTIONS);
    assert.equal(peerNativeActionCeiling(undefined, true), DEFAULT_DESKTOP_NATIVE_ACTIONS);

    // General tasks cap at 128
    assert.equal(peerNativeActionCeiling(Infinity, false), DEFAULT_AGY_NATIVE_ACTIONS);
    assert.equal(peerNativeActionCeiling(undefined, false), DEFAULT_AGY_NATIVE_ACTIONS);
    // Lower configured action ceiling takes precedence
    assert.equal(peerNativeActionCeiling(15, false), 15);
  });

  test('Autonomy mode C cannot bypass wall-clock deadline', () => {
    const start = Date.now();
    const deadline = desktopDeadline(start, 'desktop_personalization');
    assert.equal(deadline, start + DESKTOP_TASK_WALL_MS);

    // After 180s has elapsed, remainingDesktopTime is 0
    assert.equal(remainingDesktopTime(start - 1000), 0);
    // Future deadline returns remaining ms
    assert.ok(remainingDesktopTime(start + 5000)! <= 5000);
    // Non-desktop task returns null (no artificial deadline)
    assert.equal(desktopDeadline(start, 'software_engineering'), null);
  });

  test('Smaller user-configured budget takes strict precedence', () => {
    const ceiling = resolveTaskTokenCeiling({
      provider: 'antigravity',
      configured: { enabled: true, maxTokensPerTask: 5_000 }
    });
    assert.equal(ceiling, 5_000);

    // Worker limit lower than user budget wins
    const workerCeiling = resolveTaskTokenCeiling({
      provider: 'antigravity',
      workerLimit: 3_000,
      configured: { enabled: true, maxTokensPerTask: 10_000 }
    });
    assert.equal(workerCeiling, 3_000);
  });

  test('Larger explicitly configured budget is respected at task level', () => {
    const ceiling = resolveTaskTokenCeiling({
      provider: 'antigravity',
      configured: { enabled: true, maxTokensPerTask: 250_000 }
    });
    assert.equal(ceiling, 250_000);
  });

  test('Interrupted provider calls (AbortSignal) abort cleanly and do not retry paid work', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-abort-test-'));
    const agy = path.join(dir, 'agy');
    fs.writeFileSync(agy, `#!/usr/bin/env node
setTimeout(() => {}, 60000);
`, { mode: 0o755 });

    try {
      const provider = new AntigravityProvider({ command: agy, model: 'Gemini 3.8 Flash (Low)' });
      const controller = new AbortController();
      const promise = provider.chat([{ role: 'user', content: 'test abort' }], {
        signal: controller.signal,
        maxRetries: 3
      });
      setTimeout(() => controller.abort(), 50);

      await assert.rejects(promise, (err: any) => {
        assert.ok(err.name === 'AbortError' || err.message?.includes('abort'));
        return true;
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('Partial token usage is preserved in budget error and not replayed', () => {
    const errorWithUsage = Object.assign(new Error('Connection reset mid-stream'), {
      code: 'ECONNRESET',
      partialUsage: { promptTokens: 1500, completionTokens: 250 }
    });
    assert.equal(hasBillablePartialUsage(errorWithUsage), true);
    assert.equal(shouldRetryPeerError(errorWithUsage), false);
  });

  test('TokenTracker resets taskTokens between consecutive chat turns while retaining sessionTokens', async () => {
    const tracker = new TokenTracker();
    tracker.resetSession();
    tracker.resetTask();

    // Turn 1
    tracker.setEnforcedTaskLimit(40_000);
    await tracker.trackUsage(10_000, 2_000);
    assert.equal(tracker.taskTokens, 12_000);
    assert.equal(tracker.sessionTokens, 12_000);

    // Turn 2 begins: resetTask() called by AgentLoop.run()
    tracker.resetTask();
    assert.equal(tracker.taskTokens, 0, 'taskTokens must be 0 for next turn');
    assert.equal(tracker.sessionTokens, 12_000, 'sessionTokens must persist across turns');

    tracker.setEnforcedTaskLimit(40_000);
    await tracker.trackUsage(15_000, 3_000);
    assert.equal(tracker.taskTokens, 18_000);
    assert.equal(tracker.sessionTokens, 30_000);
  });

  test('Antigravity execution stops at budget checkpoint, preserves partial work, and reports outcome', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-checkpoint-test-'));
    const agy = path.join(dir, 'agy');
    fs.writeFileSync(agy, `#!/usr/bin/env node
const emit = event => process.stdout.write(JSON.stringify(event) + '\\n');
process.stdin.resume();
process.stdin.on('end', () => {
  emit({ event: 'init', conversation_id: 'checkpoint-test' });
  // Step 1: 30k tokens
  emit({
    event: 'step_update',
    step_update: {
      step_index: 1, state: 'DONE', step_type: 'agent_response',
      text_delta: 'Initial research completed.',
      usage: { input_tokens: 30000, output_tokens: 500, cache_read_tokens: 0 }
    }
  });
  // Step 2: trips 32k call limit (30k + 3k = 33k > 32k)
  emit({
    event: 'step_update',
    step_update: {
      step_index: 2, state: 'DONE', step_type: 'agent_response',
      text_delta: 'Continuing deep search...',
      usage: { input_tokens: 3000, output_tokens: 200, cache_read_tokens: 0 }
    }
  });
});
`, { mode: 0o755 });

    try {
      const provider = new AntigravityProvider({ command: agy, model: 'Gemini 3.8 Flash (Low)' });
      await assert.rejects(
        provider.chat([{ role: 'user', content: 'Explore target' }], {
          conversationId: 'checkpoint-session',
          hardBudget: false // autonomous mode C
        }),
        (err: any) => {
          assert.equal(err.code, 'AGY_TOKEN_BUDGET');
          assert.equal(err.tokenLimit, 32_000);
          assert.ok(err.message?.includes('checkpoint') || err.message?.includes('ceiling'));
          assert.ok(err.partialUsage?.promptTokens >= 30_000);
          return true;
        }
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
