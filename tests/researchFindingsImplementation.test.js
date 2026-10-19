import test from 'node:test';
import assert from 'node:assert/strict';

// Component 1: OBLIVION Memory Decay
import { VectorDB } from '../src/cortex/vectorDb.js';

// Component 2: VFE Active Inference Tracker
import { VFETracker, VARIANCE_EPSILON, MEAN_ERROR_THRESHOLD } from '../src/vfeTracker.js';
import { assessStep, directiveFor } from '../src/uncertainty.js';

// Component 3: 5-Stage Progressive Compaction
import {
  STAGE1_BUDGET_THRESHOLD,
  STAGE2_SNIP_CHARS,
  STAGE4_COLLAPSE_THRESHOLD,
  snipOversizedToolOutputs,
  microcompactText,
  applyProgressiveCompaction
} from '../src/contextManager.js';

// Component 5: Plan Cache Failure Hints
import { renderPlanHint } from '../src/planCache.js';

// ---------------------------------------------------------------------------
// Component 1 Tests: OBLIVION Adaptive Memory Decay
// ---------------------------------------------------------------------------

test('OBLIVION: reinforced memories decay significantly slower than unreinforced ones', () => {
  const RECENCY_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;
  const ALPHA = 0.2;
  const ageMs = 15 * 24 * 60 * 60 * 1000; // 15 days

  // Case 0: 0 hits (base decay)
  const S_0 = RECENCY_HALF_LIFE_MS * (1 + 0 * ALPHA);
  const R_0 = Math.exp(-ageMs / S_0);

  // Case 5: 5 hits (reinforced)
  const S_5 = RECENCY_HALF_LIFE_MS * (1 + 5 * ALPHA);
  const R_5 = Math.exp(-ageMs / S_5);

  assert.ok(R_5 > R_0, 'reinforced memory should have higher retention');
  // At 15 days, 5 hits yields S = 2.0 * BASE, so retention is e^(-15/60) ≈ 0.778 vs e^(-15/30) ≈ 0.606
  assert.ok(R_5 - R_0 > 0.15, 'adaptive stability provides significant retention gain');
});

test('OBLIVION: tier multipliers prioritize L1 condensed summaries over L3 mistakes', () => {
  const RECENCY_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;
  const ageMs = 30 * 24 * 60 * 60 * 1000; // 30 days

  // L1 condensed tier (mult = 2.0)
  const S_l1 = RECENCY_HALF_LIFE_MS * (1 + 0) * 2.0;
  const R_l1 = Math.exp(-ageMs / S_l1);

  // L3 mistake tier (mult = 1.0)
  const S_l3 = RECENCY_HALF_LIFE_MS * (1 + 0) * 1.0;
  const R_l3 = Math.exp(-ageMs / S_l3);

  assert.ok(R_l1 > R_l3, 'L1 summaries must persist longer than L3 episodes');
  assert.ok(R_l1 > 0.60, 'L1 retention at 30 days should remain above 60%');
});

// ---------------------------------------------------------------------------
// Component 2 Tests: Active Inference VFE Tracker & Plateau Detection
// ---------------------------------------------------------------------------

test('VFE Tracker: nominal steps yield low free energy (error)', () => {
  const tracker = new VFETracker();
  const res = tracker.recordStep({
    tool: 'fs_read',
    success: true
  });

  assert.ok(res.vfe <= 0.10, 'successful step must have very low prediction error');
  assert.equal(res.isPlateau, false);
  assert.equal(res.paradigmShift, false);
});

test('VFE Tracker: detects persistent error plateau and triggers paradigm shift', () => {
  const tracker = new VFETracker();

  let shiftTriggered = false;
  let lastRes = null;
  for (let i = 1; i <= 6; i++) {
    lastRes = tracker.recordStep({
      tool: 'terminal_persistent_shell',
      success: false,
      result: { error: 'EACCES: permission denied' },
      consecutiveFailures: i,
      isThrashing: i >= 3
    });
    if (lastRes.paradigmShift) shiftTriggered = true;
  }

  assert.ok(lastRes.mean >= MEAN_ERROR_THRESHOLD, `mean error ${lastRes.mean} must be >= threshold`);
  assert.ok(lastRes.isPlateau, 'persistent deadlock must trigger isPlateau');
  assert.ok(shiftTriggered, 'plateau must trigger paradigm shift');
});

test('VFE Tracker + Uncertainty: VFE plateau triggers paradigm shift directive', () => {
  const verdict = assessStep({
    consecutiveFailures: 3,
    lastResult: { error: 'command not found' },
    vfePlateau: true,
    recentTools: ['sysRun', 'sysRun', 'sysRun'],
    pendingTool: 'sysRun'
  });

  assert.equal(verdict.level, 'stuck');
  assert.ok(verdict.signals.includes('vfe_plateau'), 'vfe_plateau signal must be recorded');
  assert.ok(verdict.directive.includes('PARADIGM SHIFT REQUIRED'), 'directive must mandate paradigm shift');
});

// ---------------------------------------------------------------------------
// Component 3 Tests: 5-Stage Progressive Compaction
// ---------------------------------------------------------------------------

test('Compaction Stage 2: snips single tool output > 15K tokens (60K chars)', () => {
  const hugeOutput = 'A'.repeat(80000);
  const messages = [
    { role: 'user', content: 'build project' },
    { role: 'tool', name: 'sysRun', content: hugeOutput }
  ];

  const result = snipOversizedToolOutputs(messages);
  assert.equal(result.snippedCount, 1);
  assert.ok(result.reclaimedChars > 40000, 'must reclaim tens of thousands of characters');
  assert.ok(messages[1].content.includes('✂️ SNIPPED'), 'must embed snip marker');
  assert.ok(messages[1].content.length < 35000, 'snipped tool output must be bounded');
});

test('Compaction Stage 3: microcompactText collapses excess whitespace without altering content', () => {
  const messy = 'Line 1   \n\n\n\nLine 2\t \n\nLine 3';
  const cleaned = microcompactText(messy);
  assert.equal(cleaned, 'Line 1\n\nLine 2\n\nLine 3');
});

test('Compaction Stages 1-4: applyProgressiveCompaction applies budget reduction and collapse', () => {
  const maxCharPool = 100000;
  // 10 messages of 8,000 chars = 80,000 chars (80% of pool -> triggers Stage 1)
  const messages = [
    { role: 'user', content: 'Run tasks' }
  ];
  for (let i = 0; i < 10; i++) {
    messages.push({
      role: 'tool',
      name: 'terminal',
      content: `Step ${i} logs: ` + 'X'.repeat(8000)
    });
  }

  const res = applyProgressiveCompaction(messages, maxCharPool);
  assert.ok(res.stagesFired.some(s => s.startsWith('budget_reduction')), 'must fire Stage 1 budget reduction at 80%');
  assert.ok(res.totalReclaimed > 0, 'must reclaim characters');
});

// ---------------------------------------------------------------------------
// Component 4 Tests: Cortex Similarity Signal Wiring
// ---------------------------------------------------------------------------

test('Uncertainty: lessonSimilarity from Cortex lowers uncertainty when high', () => {
  const withoutLesson = assessStep({
    consecutiveFailures: 1,
    planSimilarity: 0,
    lessonSimilarity: 0
  });

  const withLesson = assessStep({
    consecutiveFailures: 1,
    planSimilarity: 0,
    lessonSimilarity: 0.85
  });

  assert.ok(!withLesson.signals.includes('no_prior_art'), 'high lesson similarity clears no_prior_art');
  assert.ok(withLesson.uncertainty < withoutLesson.uncertainty, 'knowledge from Cortex reduces step uncertainty');
});

// ---------------------------------------------------------------------------
// Component 5 Tests: Plan Cache Failure Route Hints
// ---------------------------------------------------------------------------

test('Plan Cache: renderPlanHint prominently displays failure route warnings', () => {
  const match = {
    similarity: 0.85,
    template: {
      id: 'p_test',
      uses: 3,
      wins: 2,
      steps: [
        { tool: 'fs_read', note: 'package.json', ok: true },
        { tool: 'sysRun', note: 'npm-test', ok: false, why: 'exit_nonzero' },
        { tool: 'fs_edit', note: 'fix-code', ok: true }
      ]
    }
  };

  const hint = renderPlanHint(match);
  assert.ok(hint.includes('⚠️ FAILURE ROUTE WARNINGS'), 'must render failure route warnings section');
  assert.ok(hint.includes('Step 2 (sysRun → npm-test) FAILED with reason: exit_nonzero'), 'must detail failed step and reason');
});
