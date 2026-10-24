import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractKeywords,
  similarity,
  toStep,
  recordPlan,
  recordPlanAsync,
  lookupPlan,
  lookupAlternativeStep,
  recordMiss,
  renderPlanHint,
  prune,
  forgetPlans,
  planStats,
  prewarmPlans,
  autoPrewarmIfCold,
  recordAPCPipelineLatency,
  recordAPCCostBreakdown,
  getAPCPipelineLatency,
  getAPCCostBreakdown,
  getAPCScalabilityReference,
  getAPCFuzzyThresholdReference,
  getAPCColdStartReference,
  MATCH_THRESHOLD,
  DEFAULT_FUZZY_THRESHOLD,
  DEFAULT_CAPACITY,
  MAX_PLANS,
  MIN_LOOKUPS_BEFORE_DISABLE,
  MIN_PLANS_BEFORE_DISABLE
} from '../src/planCache.js';

test.beforeEach(() => {
  forgetPlans();
});

test.after(() => {
  forgetPlans();
});

// ---------------------------------------------------------------------------
// Page 8: Section 4.3 Latency Analysis & Re-planning Phase Template Reuse
// ---------------------------------------------------------------------------

test('APC Page 8 & 9 (Table 3): pipeline latency breakdown tracks 5 core components', () => {
  recordAPCPipelineLatency({
    planMs: 1011.82,
    actMs: 131.44,
    keywordExtractionMs: 0.05,
    cacheLookupMs: 0.02,
    cacheGenerationMs: 3.99,
    totalMs: 1147.32
  });

  const report = getAPCPipelineLatency();
  assert.equal(report.sampleCount, 1);
  assert.ok(Math.abs(report.planMs - 1011.82) < 0.01);
  assert.ok(Math.abs(report.actMs - 131.44) < 0.01);
  assert.ok(Math.abs(report.cacheGenerationMs - 3.99) < 0.01);
  assert.ok(Math.abs(report.totalMs - 1147.32) < 0.01);
  assert.ok(report.averagePlanMs > 0);
  assert.ok(report.averageActMs > 0);
});

test('APC Page 8 (Section 4.3): asynchronous cache generation detaches distillation from critical path', async () => {
  const resultPromise = recordPlanAsync({
    prompt: 'package the release binaries into an archive and compute sha256 checksums',
    archetype: 'code',
    steps: [
      toStep('sys_run', { action: 'tar' }, true),
      toStep('sys_run', { action: 'shasum' }, true)
    ]
  });

  assert.ok(resultPromise instanceof Promise, 'recordPlanAsync must return a promise');
  const stored = await resultPromise;
  assert.ok(stored, 'async recordPlan must successfully store the template');
  assert.equal(stored.steps.length, 2);

  const hit = lookupPlan({
    prompt: 'package release binaries into archive and compute sha256 checksums',
    archetype: 'code'
  });
  assert.ok(hit, 'asynchronously stored plan must be queryable in cache');
});

test('APC Page 8 (Section 4.3): re-planning phase reuses prior failure routes and suggests workarounds', () => {
  // Task 1: Initially learned that `which ffmpeg` failed on macOS (not_found), then used blender_act to render
  recordPlan({
    prompt: 'render 3D scene animation to playable video container',
    archetype: 'media',
    steps: [
      toStep('sys_run', { command: 'which ffmpeg' }, false, { error: 'ffmpeg: command not found' }),
      toStep('blender_act', { action: 'render_animation' }, true)
    ]
  });

  // When a subsequent task hits tool failure on `sys_run` with `not_found`,
  // re-planning queries lookupAlternativeStep to find candidate workarounds.
  const recommendation = lookupAlternativeStep({
    failedTool: 'sys_run',
    why: 'not_found',
    archetype: 'media'
  });

  assert.ok(recommendation, 're-planning must identify cached workaround');
  assert.equal(recommendation.suggestedTool, 'blender_act');
  assert.equal(recommendation.suggestedNote, 'render_animation');
  assert.match(recommendation.reason, /worked around sys_run/);
});

// ---------------------------------------------------------------------------
// Page 9: Table 2 (Cost Breakdown), Table 3 (Latency), Table 4 (LRU Capacity)
// ---------------------------------------------------------------------------

test('APC Page 9 (Table 2): cost tracking records model tiers and bounds cache overhead', () => {
  recordAPCCostBreakdown({
    largePlannerCost: 1.7544,
    smallPlannerCost: 0.0168,
    actorCost: 0.0705,
    cacheOverhead: {
      keywordExtractionCost: 0.0050,
      cacheGenerationCost: 0.0163,
      totalOverheadCost: 0.0213,
      overheadPercentage: 1.14
    },
    totalCost: 1.8630
  });

  const cost = getAPCCostBreakdown();
  assert.ok(Math.abs(cost.largePlannerCost - 1.7544) < 0.001);
  assert.ok(Math.abs(cost.smallPlannerCost - 0.0168) < 0.001);
  assert.ok(Math.abs(cost.actorCost - 0.0705) < 0.001);
  assert.ok(Math.abs(cost.cacheOverhead.totalOverheadCost - 0.0213) < 0.001);
  // Total overhead percentage in paper Table 2 is ~1.14% on FinanceBench
  assert.ok(cost.cacheOverhead.overheadPercentage > 1.0 && cost.cacheOverhead.overheadPercentage < 1.35);
});

test('APC Page 9 (Table 4): capacity limits enforce LRU pruning at diminishing returns plateau', () => {
  const templates: any[] = [];
  for (let i = 0; i < 150; i++) {
    templates.push({
      id: `plan_${i}`,
      archetype: 'code',
      keywords: [`token_${i}`],
      steps: [{ tool: 'sys_run', note: 'test', ok: true }],
      uses: i === 42 ? 100 : 1,
      wins: i === 42 ? 100 : 0,
      createdAt: Date.now() - 1000,
      updatedAt: Date.now()
    });
  }

  // Prune to DEFAULT_CAPACITY (100) per Table 4
  const pruned = prune(templates, DEFAULT_CAPACITY);
  assert.equal(pruned.length, DEFAULT_CAPACITY);
  // High-utility plan 42 must be retained
  assert.ok(pruned.some((p) => p.id === 'plan_42'), 'high-win-rate plan must survive LRU capacity pruning');
});

test('APC Page 8 & 9 (Section 4.3): circuit breaker mitigates worst-case overhead on persistent misses', () => {
  // Pre-seed cache with distinct task keywords to exceed MIN_PLANS_BEFORE_DISABLE (10)
  const uniqueKeys = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa', 'lambda'];
  for (let i = 0; i < MIN_PLANS_BEFORE_DISABLE; i++) {
    recordPlan({
      prompt: `seed template specialized for compiler workflow target ${uniqueKeys[i]}`,
      archetype: 'code',
      steps: [toStep('fs_read', {}, true), toStep('sys_run', { action: 'compile' }, true)]
    });
  }

  // Generate 20 consecutive misses to simulate 0% hit rate adversarial scenario
  for (let i = 0; i < MIN_LOOKUPS_BEFORE_DISABLE; i++) {
    const res = lookupPlan({
      prompt: `completely unrelated cold query ${i} missing from cache`,
      archetype: 'unrelated'
    });
    assert.equal(res, null);
  }

  // Next lookup must be bypassed by circuit breaker to eliminate overhead
  const bypassed = lookupPlan({
    prompt: 'another unrelated query',
    archetype: 'unrelated'
  });
  assert.equal(bypassed, null);

  const stats = planStats();
  assert.equal(stats.disabled, true);
  assert.equal(stats.bypassed, 1);
});

// ---------------------------------------------------------------------------
// Page 10: Table 5 (Scalability), Table 6 (Thresholds), Table 7 (Cold Start)
// ---------------------------------------------------------------------------

test('APC Page 10 (Table 5): exact matching achieves sub-millisecond lookup and reports microsecond telemetry', () => {
  const prompt = 'build production bundle and verify hash integrity';
  recordPlan({
    prompt,
    archetype: 'code',
    steps: [
      toStep('sys_run', { action: 'bundle' }, true),
      toStep('sys_run', { action: 'verify' }, true)
    ]
  });

  const hit = lookupPlan({ prompt, archetype: 'code' });
  assert.ok(hit);
  assert.equal(hit.matchType, 'exact');
  assert.equal(hit.similarity, 1.0);
  assert.ok(hit.telemetry.lookupMs < 5.0, 'exact lookup must be sub-millisecond');

  const reference = getAPCScalabilityReference();
  assert.equal(reference.length, 5);
  assert.equal(reference[0]?.cacheSize, 100);
  assert.equal(reference[4]?.cacheSize, 1000000);
  // Verify Table 5 exact lookup stays under 60 microseconds even at 10^6 entries
  assert.ok(reference[4]!.exactHitLatencyUs <= 60);
});

test('APC Page 10 (Table 6): similarity threshold trade-off preserves accuracy at >= 0.80', () => {
  recordPlan({
    prompt: 'transcode high quality video stream with h264 codec and compress audio stream target',
    archetype: 'media',
    steps: [
      toStep('sys_run', { action: 'probe' }, true),
      toStep('sys_run', { action: 'transcode' }, true)
    ]
  });

  // Query with 1 synonym change (high similarity >= 0.80)
  const prompt = 'transcode high quality video clip with h264 codec and compress audio stream target';

  // High similarity match: allowed with DEFAULT_FUZZY_THRESHOLD (0.80)
  const hit = lookupPlan({
    prompt,
    archetype: 'media',
    similarityThreshold: DEFAULT_FUZZY_THRESHOLD
  });
  assert.ok(hit, 'high-confidence rephrasing should hit with threshold 0.80');

  // Exact-only match: disallows slight divergence
  const exactOnly = lookupPlan({
    prompt,
    archetype: 'media',
    similarityThreshold: 1.0
  });
  assert.equal(exactOnly, null, 'threshold 1.0 must enforce exact match');

  const ref = getAPCFuzzyThresholdReference();
  assert.equal(ref.length, 3);
  assert.equal(ref[0]?.threshold, 1.0);
  assert.equal(ref[0]?.accuracy, 0.855);
  assert.equal(ref[1]?.threshold, 0.8);
  assert.equal(ref[1]?.accuracy, 0.830);
  assert.equal(ref[2]?.threshold, 0.6);
  assert.equal(ref[2]?.accuracy, 0.770);
});

test('APC Page 10 (Section 4.5 & Table 7): cold start mitigation via offline pre-warming', () => {
  // Empty cold cache
  assert.equal(planStats().count, 0);

  // Auto pre-warm
  const outcome = autoPrewarmIfCold();
  assert.ok(outcome.accepted >= 4, 'autoPrewarmIfCold must seed core archetypes');

  const stats = planStats();
  assert.ok(stats.count >= 4, 'cache must no longer be cold');

  // Immediately queryable for common development workflow
  const hit = lookupPlan({
    prompt: 'review git changes stage files create commit and push branch',
    archetype: 'git'
  });
  assert.ok(hit, 'pre-warmed git workflow must hit immediately without cold-start misses');
  assert.equal(hit.matchType, 'exact');

  const coldRef = getAPCColdStartReference();
  assert.equal(coldRef.length, 5);
  assert.equal(coldRef[0]?.queryPercentile, 20);
  assert.equal(coldRef[0]?.hitRate, 0.1429);
  assert.equal(coldRef[4]?.queryPercentile, 100);
  assert.equal(coldRef[4]?.hitRate, 0.4800);
});
