import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  UnifiedBudgetEnforcer,
  EfficiencyCheckpoint,
  actionLimitFor,
  noncachedTokens
} from '../src/providers/budgetEnforcer.js';

test('noncachedTokens calculates input and completion tokens with cache deduction', () => {
  const usage1 = { promptTokens: 10_000, completionTokens: 2_000, cachedPromptTokens: 8_000 };
  assert.equal(noncachedTokens(usage1), 2_000 + 2_000); // 2,000 uncached input + 2,000 completion = 4,000

  const usage2 = { promptTokens: 5_000, completionTokens: 1_000, uncachedPromptTokens: 3_000 };
  assert.equal(noncachedTokens(usage2), 3_000 + 1_000); // 4,000
});

test('actionLimitFor returns strictly bounded limits per task archetype', () => {
  assert.equal(actionLimitFor('desktop_personalization'), 12);
  assert.equal(actionLimitFor('media_3d_generation'), 25);
  assert.equal(actionLimitFor('web_fullstack'), 35);
  assert.equal(actionLimitFor('system_admin'), 35);
});

test('UnifiedBudgetEnforcer halts turn when token limit is exceeded', () => {
  const enforcer = new UnifiedBudgetEnforcer(5_000, 10);
  enforcer.recordUsage({ promptTokens: 3_000, completionTokens: 1_000 });
  assert.equal(enforcer.getRemainingTokens(), 1_000);

  assert.throws(
    () => enforcer.recordUsage({ promptTokens: 2_000, completionTokens: 500 }),
    (error: unknown) => {
      assert.ok(error instanceof EfficiencyCheckpoint);
      assert.equal((error as EfficiencyCheckpoint).reason, 'tokens');
      return true;
    }
  );
});

test('UnifiedBudgetEnforcer halts turn when action count cap is exceeded', () => {
  const enforcer = new UnifiedBudgetEnforcer(100_000, 3);
  enforcer.recordAction('action-1');
  enforcer.recordAction('action-1'); // Deduplicated: duplicate nativeId should not increment
  assert.equal(enforcer.getRemainingActions(), 2);

  enforcer.recordAction('action-2');
  enforcer.recordAction('action-3');
  assert.equal(enforcer.getRemainingActions(), 0);

  assert.throws(
    () => enforcer.recordAction('action-4'),
    (error: unknown) => {
      assert.ok(error instanceof EfficiencyCheckpoint);
      assert.equal((error as EfficiencyCheckpoint).reason, 'actions');
      return true;
    }
  );
});

test('UnifiedBudgetEnforcer allows multi-turn tasks to progress within task token ceiling', () => {
  const enforcer = new UnifiedBudgetEnforcer(100_000, 35, 500_000);
  assert.equal(enforcer.getRemainingTokens(), 500_000);
  assert.equal(enforcer.getRemainingTurnTokens(), 100_000);

  // Simulate 7 steps of 20,000 noncached tokens each (total 140,000 tokens)
  for (let i = 0; i < 7; i++) {
    enforcer.recordUsage({ promptTokens: 15_000, completionTokens: 5_000 });
  }
  assert.equal(enforcer.getRemainingTokens(), 360_000);

  // Single turn blowout exceeding 100,000 tokens throws turn-scoped checkpoint
  assert.throws(
    () => enforcer.recordUsage({ promptTokens: 120_000, completionTokens: 5_000 }),
    (error: unknown) => {
      assert.ok(error instanceof EfficiencyCheckpoint);
      assert.equal((error as EfficiencyCheckpoint).reason, 'tokens');
      assert.equal((error as EfficiencyCheckpoint).scope, 'turn');
      return true;
    }
  );
});

test('UnifiedBudgetEnforcer halts when cumulative task limit is reached', () => {
  const enforcer = new UnifiedBudgetEnforcer(50_000, 35, 100_000);
  enforcer.recordUsage({ promptTokens: 40_000, completionTokens: 5_000 }); // 45k
  enforcer.recordUsage({ promptTokens: 40_000, completionTokens: 5_000 }); // 90k
  assert.equal(enforcer.getRemainingTokens(), 10_000);

  assert.throws(
    () => enforcer.recordUsage({ promptTokens: 15_000, completionTokens: 5_000 }), // 110k > 100k
    (error: unknown) => {
      assert.ok(error instanceof EfficiencyCheckpoint);
      assert.equal((error as EfficiencyCheckpoint).reason, 'tokens');
      assert.equal((error as EfficiencyCheckpoint).scope, 'task');
      return true;
    }
  );
});

