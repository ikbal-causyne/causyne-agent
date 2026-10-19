import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { assessStep, isThrashing, directiveFor, CONTESTED_AT, STUCK_AT } from '../src/uncertainty.js';

function sourceWithoutComments(url) {
  return fs.readFileSync(url, 'utf8')
    .split('\n')
    .filter((line) => {
      const s = line.trim();
      return !s.startsWith('//') && !s.startsWith('*') && !s.startsWith('/*');
    })
    .join('\n');
}

test('gate: a clean step says nothing at all', () => {
  // The empty directive IS the economics. Reflecting on every step is the waste
  // the whole gating idea exists to prevent, and the directive costs tokens on
  // every step it appears in.
  const verdict = assessStep({
    consecutiveFailures: 0,
    recentTools: ['fs_read', 'fs_write'],
    pendingTool: 'sysRun',
    planSimilarity: 0.6,
    assistantText: 'Writing the encoder script now.'
  });

  assert.equal(verdict.level, 'confident');
  assert.equal(verdict.directive, '', 'a settled step was charged for a reflection directive');
});

test('gate: it costs nothing — no sampling, no second model, no network', () => {
  // The design-deciding constraint. Without logprobs every CATTS-family method
  // samples N completions; a gate that costs N times what it gates is not a
  // gate. Nothing in this module may reach for inference.
  const src = sourceWithoutComments(new URL('../src/uncertainty.js', import.meta.url));
  for (const forbidden of ['fetch(', '.chat(', 'createProvider', 'await ', 'require(']) {
    assert.ok(!src.includes(forbidden), `the uncertainty gate reached for ${forbidden}`);
  }
});

test('gate: repetition is the cheapest honest signal', () => {
  assert.equal(isThrashing(['fs_read', 'fs_read'], 'fs_read'), true);
  assert.equal(isThrashing(['fs_read', 'fs_write'], 'fs_read'), false);
  // Two of a kind is a legitimate read-then-write pair, not thrashing.
  assert.equal(isThrashing(['fs_read'], 'fs_read'), false);
  assert.equal(isThrashing([], 'fs_read'), false);
});

test('gate: a wrong ROUTE escalates, a bad MOMENT does not', () => {
  // Retrying is the correct response to a network blip. Treating it as
  // uncertainty would re-plan around a problem that fixes itself.
  const routeWrong = assessStep({
    consecutiveFailures: 2,
    lastResult: { error: 'ffmpeg: command not found' },
    recentTools: ['sysRun', 'sysRun'],
    pendingTool: 'sysRun'
  });
  const badMoment = assessStep({
    consecutiveFailures: 2,
    lastResult: { error: 'connect ECONNREFUSED 127.0.0.1:8080' },
    recentTools: ['web_fetch', 'fs_read'],
    pendingTool: 'web_fetch'
  });

  assert.ok(routeWrong.uncertainty > badMoment.uncertainty,
    'a network blip scored as high as a wrong route');
  assert.ok(routeWrong.signals.some((s) => s.startsWith('route_wrong')));
  assert.ok(!badMoment.signals.some((s) => s.startsWith('route_wrong')));
});

test('gate: no single signal can decide the outcome on its own', () => {
  // Verbalized confidence is poorly calibrated. If hedging alone could cross
  // the threshold, the gate would fire on ordinary careful writing.
  const hedgeOnly = assessStep({
    consecutiveFailures: 0,
    planSimilarity: 1,
    assistantText: "I'm not sure this is the right file, but let me try."
  });
  assert.ok(hedgeOnly.uncertainty < CONTESTED_AT,
    'hedging language alone triggered reflection');

  const thrashOnly = assessStep({
    consecutiveFailures: 0,
    planSimilarity: 1,
    recentTools: ['fs_read', 'fs_read'],
    pendingTool: 'fs_read'
  });
  assert.ok(thrashOnly.uncertainty < CONTESTED_AT, 'one signal crossed the gate alone');
});

test('gate: signals accumulate into a re-plan when nothing is converging', () => {
  const lost = assessStep({
    consecutiveFailures: 3,
    lastResult: { error: 'EACCES: permission denied' },
    recentTools: ['sysRun', 'sysRun'],
    pendingTool: 'sysRun',
    planSimilarity: 0,
    assistantText: 'It is unclear why this keeps failing.'
  });

  assert.ok(lost.uncertainty >= STUCK_AT, `expected stuck, scored ${lost.uncertainty}`);
  assert.equal(lost.level, 'stuck');
  assert.match(lost.directive, /RE-PLAN/);
  assert.match(lost.directive, /not found.*ROUTE/s,
    'the re-plan directive must carry the lesson that a failed lookup is not proof of absence');
});

test('gate: a missing logprob margin is not evidence of confidence', () => {
  // Several BYOK providers expose no logprobs. Absence must contribute nothing
  // in either direction, or every Anthropic step would read as certain.
  const without = assessStep({ consecutiveFailures: 1, planSimilarity: 0.5 });
  const withWide = assessStep({ consecutiveFailures: 1, planSimilarity: 0.5, logprobMargin: 4.0 });
  assert.equal(without.uncertainty, withWide.uncertainty);

  const withNarrow = assessStep({ consecutiveFailures: 1, planSimilarity: 0.5, logprobMargin: 0.1 });
  assert.ok(withNarrow.uncertainty > without.uncertainty, 'a narrow margin was ignored');
});

test('gate: the directive rides the VOLATILE block, never a cached one', () => {
  // It changes every step. In a cacheAnchor block it would invalidate the
  // cached prefix on every single request — the exact failure the prompt
  // ordering exists to avoid.
  const loop = sourceWithoutComments(new URL('../src/agentLoop.js', import.meta.url));
  const at = loop.indexOf('uncertaintyDirective ?');
  assert.ok(at > 0, 'the directive is no longer injected');

  const block = loop.slice(at, at + 400);
  assert.ok(!/cacheAnchor:\s*true/.test(block),
    'the per-step directive landed inside a cached block');
  assert.match(block, /CURRENT AUTONOMY MODE/, 'it left the volatile tail');
});

test('gate: directiveFor is silent unless there is something to say', () => {
  assert.equal(directiveFor('confident', []), '');
  assert.match(directiveFor('contested', ['thrash:fs_read']), /CHECK YOURSELF/);
  assert.match(directiveFor('contested', ['thrash:fs_read']), /thrash:fs_read/,
    'the directive should name why it fired, so the model can disagree with it');
});

test('gate: a wrong route without thrashing retries the SUB-PROBLEM, not the plan', () => {
  // IARS separates [RETRY_SUBPROBLEM] from a full re-plan. Tearing up a plan
  // because one step took a wrong route throws away everything that was right.
  const { directive } = assessStep({
    consecutiveFailures: 3,
    lastResult: { error: 'ffmpeg: command not found' },
    recentTools: ['blender_act', 'fs_write'],
    pendingTool: 'sysRun',
    planSimilarity: 0
  });
  assert.match(directive, /RETRY_SUBPROBLEM/);
  assert.match(directive, /Keep the overall plan/);
});

test('gate: escalation widens the search, and only then', () => {
  // IARS: [DEEPER_THINK] raises temperature. The paper gives the direction and
  // no magnitude, so the delta is ours — but its presence on a stuck step and
  // absence on a confident one is the paper's.
  const { STUCK_TEMPERATURE_DELTA } = require_uncertainty();
  const calm = assessStep({ consecutiveFailures: 0, planSimilarity: 0.6 });
  const stuck = assessStep({
    consecutiveFailures: 3, lastResult: { error: 'EACCES: permission denied' },
    recentTools: ['sysRun', 'sysRun'], pendingTool: 'sysRun', planSimilarity: 0,
    assistantText: 'It is unclear why this keeps failing.'
  });
  assert.equal(calm.temperatureDelta, 0, 'a confident step had its decoding widened');
  assert.equal(stuck.temperatureDelta, STUCK_TEMPERATURE_DELTA);
  assert.ok(STUCK_TEMPERATURE_DELTA > 0 && STUCK_TEMPERATURE_DELTA <= 0.3,
    'a stuck agent needs a different route, not a random one');
});

function require_uncertainty() { return globalThis.__uncertaintyModule; }
test.before(async () => { globalThis.__uncertaintyModule = await import('../src/uncertainty.js'); });
