#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

interface BenchmarkMeasurement {
  iterations: number;
  averageMs: number;
  medianMs: number;
  p95Ms: number;
  maxMs: number;
}

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
const missIterations = 16;

function sample(index: number) {
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

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] ?? 0;
}

function measure(iterations: number, operation: (index: number) => void): BenchmarkMeasurement {
  const values: number[] = [];
  for (let index = 0; index < iterations; index++) {
    const startedAt = performance.now();
    operation(index);
    values.push(performance.now() - startedAt);
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    iterations,
    averageMs: values.length > 0 ? total / values.length : 0,
    medianMs: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    maxMs: values.length > 0 ? Math.max(...values) : 0
  };
}

function fixed(value: number): number {
  return Number(value.toFixed(4));
}

function compactMeasurement(measurement: BenchmarkMeasurement): BenchmarkMeasurement {
  return {
    iterations: measurement.iterations,
    averageMs: fixed(measurement.averageMs),
    medianMs: fixed(measurement.medianMs),
    p95Ms: fixed(measurement.p95Ms),
    maxMs: fixed(measurement.maxMs)
  };
}

function prewarmInBatches(seeds: ReturnType<typeof sample>[]) {
  const combined: { accepted: number; rejected: number; errors: string[] } = { accepted: 0, rejected: 0, errors: [] };
  for (let offset = 0; offset < seeds.length; offset += 100) {
    const batch = prewarmPlans(seeds.slice(offset, offset + 100));
    combined.accepted += batch.accepted;
    combined.rejected += batch.rejected;
    combined.errors.push(...batch.errors);
  }
  return combined;
}

const results: Record<string, unknown>[] = [];

try {
  for (const size of sizes) {
    forgetPlans();
    const seeds = Array.from({ length: size }, (_, index) => sample(index));
    const prewarmStartedAt = performance.now();
    const prewarm = prewarmInBatches(seeds);
    const prewarmMs = performance.now() - prewarmStartedAt;
    const target = sample(Math.floor(size / 2));

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
