#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

// Never inspect or mutate a user's real plan cache. utils/paths.js resolves the
// state root at module initialization, so set it before importing planCache.js.
const benchmarkHome = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-plan-cache-bench-'));
process.env.CAUSYNE_HOME = benchmarkHome;

const {
  forgetPlans,
  lookupPlan,
  planStats,
  prewarmPlans
} = await import('../planCache.js');

const sizes = [1, 10, 20, 50, 100, 200];
const hitIterations = 500;
// Production deliberately cools down after a sustained low hit rate. Staying
// below that threshold measures a real miss scan instead of the cheap bypass.
const missIterations = 16;

function sample(index) {
  const key = `taskkey${String(index).padStart(3, '0')}`;
  return {
    prompt: `benchmark workflow ${key} inspect validate artifact`,
    archetype: 'benchmark',
    steps: [
      { tool: 'fs_search', action: 'inspect', ok: true },
      { tool: 'sys_run', action: 'validate', ok: true }
    ]
  };
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

function measure(iterations, operation) {
  const values = [];
  for (let index = 0; index < iterations; index++) {
    const startedAt = performance.now();
    operation(index);
    values.push(performance.now() - startedAt);
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    iterations,
    averageMs: total / values.length,
    medianMs: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: Math.max(...values)
  };
}

function fixed(value) {
  return Number(value.toFixed(4));
}

function compactMeasurement(measurement) {
  return {
    iterations: measurement.iterations,
    averageMs: fixed(measurement.averageMs),
    medianMs: fixed(measurement.medianMs),
    p95Ms: fixed(measurement.p95Ms),
    maxMs: fixed(measurement.maxMs)
  };
}

function prewarmInBatches(seeds) {
  const combined = { accepted: 0, rejected: 0, errors: [] };
  for (let offset = 0; offset < seeds.length; offset += 100) {
    const batch = prewarmPlans(seeds.slice(offset, offset + 100));
    combined.accepted += batch.accepted;
    combined.rejected += batch.rejected;
    combined.errors.push(...batch.errors);
  }
  return combined;
}

const results = [];

try {
  for (const size of sizes) {
    forgetPlans();
    const seeds = Array.from({ length: size }, (_, index) => sample(index));
    const prewarmStartedAt = performance.now();
    const prewarm = prewarmInBatches(seeds);
    const prewarmMs = performance.now() - prewarmStartedAt;
    const target = sample(Math.floor(size / 2));

    // Warm filesystem and in-memory index before measuring lookup paths.
    lookupPlan({ prompt: target.prompt, archetype: target.archetype, allowFuzzy: true });

    const exact = measure(hitIterations, () => {
      const match = lookupPlan({
        prompt: target.prompt,
        archetype: target.archetype,
        allowFuzzy: true
      });
      if (!match || match.matchType !== 'exact') {
        throw new Error(`Exact lookup failed at cache size ${size}`);
      }
    });

    const fuzzyPrompt = target.prompt.replace('validate artifact', 'validate repaired artifact');
    const fuzzy = measure(hitIterations, () => {
      const match = lookupPlan({
        prompt: fuzzyPrompt,
        archetype: target.archetype,
        allowFuzzy: true
      });
      if (!match || match.matchType !== 'fuzzy') {
        throw new Error(`Fuzzy lookup failed at cache size ${size}`);
      }
    });

    const miss = measure(missIterations, (index) => {
      const match = lookupPlan({
        prompt: `unrelated cold miss ${size} ${index} quantum orchard telescope`,
        archetype: 'different-archetype',
        allowFuzzy: true
      });
      if (match) throw new Error(`Unexpected cache hit at cache size ${size}`);
    });

    results.push({
      cacheSize: size,
      acceptedSeeds: prewarm.accepted,
      prewarmMs: fixed(prewarmMs),
      exact: compactMeasurement(exact),
      fuzzy: compactMeasurement(fuzzy),
      miss: compactMeasurement(miss),
      telemetry: planStats()
    });
  }

  const report = {
    benchmark: 'Causyne Agent plan cache lookup',
    generatedAt: new Date().toISOString(),
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    method: {
      cacheSizes: sizes,
      hitIterations,
      missIterations,
      note: 'Synthetic microbenchmark. It measures Causyne cache operations only; it does not reproduce paper task accuracy, model cost, or end-to-end agent latency.'
    },
    results
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  fs.rmSync(benchmarkHome, { recursive: true, force: true });
}
