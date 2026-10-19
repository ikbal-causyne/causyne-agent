import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { resolveRoute, routedConfig, UTILITY_KINDS } from '../src/modelRouter.js';
import {
  extractKeywords, similarity, toStep, recordPlan, lookupPlan,
  recordMiss, renderPlanHint, prune, forgetPlans, MATCH_THRESHOLD, MAX_PLANS
} from '../src/planCache.js';
import { resultCapFor, DEFAULT_RESULT_CAP } from '../src/contextManager.js';

test.beforeEach(() => { forgetPlans(); });
test.after(() => { forgetPlans(); });

// ---------------------------------------------------------------------------
// Model router
// ---------------------------------------------------------------------------

test('router: utility work moves to the cheaper tier of the SAME provider', () => {
  const route = resolveRoute({ provider: 'anthropic', model: 'claude-opus-5' }, 'condense');
  assert.equal(route.routed, true);
  assert.equal(route.model, 'claude-haiku-4-5');
  assert.equal(route.provider, 'anthropic', 'a route may never change provider — BYOK is one key');
});

test('router: reasoning work is never downgraded', () => {
  const route = resolveRoute({ provider: 'openai', model: 'gpt-6-astra' }, 'reasoning');
  assert.equal(route.routed, false);
  assert.equal(route.model, 'gpt-6-astra');
});

test('router: an unknown provider pays full rate rather than guessing', () => {
  // An invented model id is a 404 mid-task, or a real model at a price nobody
  // predicted. Both are worse than not saving money.
  const route = resolveRoute({ provider: 'xai', model: 'grok-4.5' }, 'condense');
  assert.equal(route.routed, false);
  assert.match(route.reason, /no published utility tier/);
});

test('router: cost is never a reason to opt someone into training', () => {
  // Muse's cheap tier is `-contributor`, discounted because the vendor trains
  // on the content. That is a privacy decision and it stays the user's.
  const fromStandard = resolveRoute({ provider: 'muse', model: 'muse-spark-1.3' }, 'condense');
  assert.equal(fromStandard.routed, false, 'routing silently opted a user into training');

  // And the reverse: a contributor user is not silently upgraded either.
  const fromContributor = resolveRoute(
    { provider: 'muse', model: 'muse-spark-1.3-contributor' }, 'condense');
  assert.equal(fromContributor.routed, false);
});

test('router: an explicit config choice outranks the table', () => {
  const route = resolveRoute(
    { provider: 'openai', model: 'gpt-6-astra', modelRouting: { utility: 'gpt-5.6-luna' } },
    'keywords'
  );
  assert.equal(route.model, 'gpt-5.6-luna');
  assert.equal(route.routed, true);
});

test('router: routing can be switched off entirely', () => {
  const route = resolveRoute(
    { provider: 'anthropic', model: 'claude-opus-5', disableModelRouting: true }, 'condense');
  assert.equal(route.routed, false);
});

test('router: routedConfig changes the model and nothing else', () => {
  const config = { provider: 'anthropic', model: 'claude-opus-5', apiKey: 'ENC:secret', baseUrl: 'https://x' };
  const { config: routed } = routedConfig(config, 'condense');
  assert.equal(routed.model, 'claude-haiku-4-5');
  assert.equal(routed.apiKey, config.apiKey, 'the key must survive the route');
  assert.equal(routed.baseUrl, config.baseUrl);
  assert.equal(config.model, 'claude-opus-5', 'the caller\'s config was mutated');
});

test('router: every declared utility kind actually routes', () => {
  for (const kind of UTILITY_KINDS) {
    const route = resolveRoute({ provider: 'openai', model: 'gpt-6-astra' }, kind);
    assert.equal(route.routed, true, `"${kind}" is declared utility but did not route`);
  }
});

// ---------------------------------------------------------------------------
// Plan cache
// ---------------------------------------------------------------------------

test('plan cache: keywords are extracted without a model call', () => {
  const source = fs.readFileSync(new URL('../src/planCache.js', import.meta.url), 'utf8');
  assert.ok(!/\ballm\b|\.chat\(|createProvider/.test(source),
    'the plan cache reached for inference; the whole point is that it does not');

  const words = extractKeywords('Buat pena 3D di Blender dan render jadi klip sinematik 8 detik');
  assert.ok(words.includes('blender') && words.includes('sinematik'));
  assert.ok(!words.includes('dan') && !words.includes('buat'),
    'generic verbs and connectives inflate the union without discriminating');
});

test('plan cache: the same job phrased differently still matches', () => {
  recordPlan({
    prompt: 'Buat pena 3D di Blender dan render jadi klip sinematik 8 detik',
    archetype: 'media',
    steps: [
      toStep('blender_act', { action: 'checkBridge' }, true),
      toStep('blender_act', { action: 'smartGeometry' }, true),
      toStep('blender_act', { action: 'render_animation' }, true)
    ]
  });

  const hit = lookupPlan({ prompt: 'bikin pulpen 3D di blender lalu render klip sinematik', archetype: 'media' });
  assert.ok(hit, 'a re-phrasing of the same job missed the cache');
  assert.ok(hit.similarity >= MATCH_THRESHOLD);
});

test('plan cache: archetype is a hard gate, not a score', () => {
  // "build a 3D scene" sharing three words with "debug the build" is not a plan
  // for it, however high the overlap.
  recordPlan({
    prompt: 'render a cinematic blender clip',
    archetype: 'media',
    steps: [toStep('blender_act', { action: 'render' }, true), toStep('view_image', {}, true)]
  });

  assert.equal(lookupPlan({ prompt: 'render a cinematic blender clip', archetype: 'code' }), null);
});

test('plan cache: a failed step is remembered AS failed', () => {
  // This is most of the value. A real run spent four steps relearning that
  // `which ffmpeg` proves nothing on macOS.
  recordPlan({
    prompt: 'encode the rendered frames into a video file',
    archetype: 'media',
    steps: [
      toStep('sysRun', { command: 'which ffmpeg' }, false),
      toStep('blender_act', { action: 'render_animation' }, true)
    ]
  });

  const hint = renderPlanHint(lookupPlan({
    prompt: 'encode the rendered frames into a video file', archetype: 'media' }));

  assert.match(hint, /FAILED last time/);
  assert.match(hint, /Evidence, not instructions/, 'a cached plan must never read as a script');
});

test('plan cache: nothing but a route is stored — no paths, no arguments', () => {
  const step = toStep('fs_write', {
    path: '/Users/example/secret-project/api_keys.env',
    content: 'OPENAI_KEY=sk-live-abc123',
    action: 'overwrite'
  }, true);

  assert.equal(step.tool, 'fs_write');
  assert.equal(step.note, 'overwrite');
  const serialised = JSON.stringify(step);
  assert.ok(!/local-user|secret-project|sk-live|api_keys/.test(serialised),
    'a path or argument leaked into the plan cache');
});

test('plan cache: a one-step task teaches nothing and is not stored', () => {
  assert.equal(recordPlan({ prompt: 'list the files here', archetype: 'code', steps: [toStep('fs_list', {}, true)] }), null);
});

test('plan cache: a plan that does not carry a task loses rank', () => {
  const stored = recordPlan({
    prompt: 'compile the android release build',
    archetype: 'code',
    steps: [toStep('sysRun', { action: 'gradle' }, true), toStep('fs_read', {}, true)]
  });
  assert.equal(stored.uses, 1);
  assert.equal(stored.wins, 1);

  recordMiss(stored.id);
  const after = lookupPlan({ prompt: 'compile the android release build', archetype: 'code' });
  assert.equal(after.template.uses, 2, 'the denominator did not move');
  assert.equal(after.template.wins, 1, 'a miss must never award a win');
});

test('plan cache: the store stays bounded, keeping what proved useful', () => {
  const many = [];
  for (let i = 0; i < MAX_PLANS + 25; i++) {
    many.push({
      id: `p${i}`, archetype: 'code', keywords: [`k${i}`], steps: [],
      uses: i === 0 ? 50 : 1, wins: i === 0 ? 50 : 0,
      createdAt: Date.now(), updatedAt: Date.now()
    });
  }
  const kept = prune(many);
  assert.equal(kept.length, MAX_PLANS);
  assert.ok(kept.some((t) => t.id === 'p0'), 'the most useful plan was pruned away');
});

test('plan cache: a corrupt store degrades to a cold one, never to a crash', async () => {
  const { PLAN_FILE } = await import('../src/planCache.js');
  fs.writeFileSync(PLAN_FILE, '{ not json');
  assert.doesNotThrow(() => lookupPlan({ prompt: 'anything at all', archetype: 'code' }));
  assert.equal(lookupPlan({ prompt: 'anything at all', archetype: 'code' }), null);
});

test('plan cache: similarity is symmetric and bounded', () => {
  const a = ['blender', 'render', 'clip'];
  const b = ['blender', 'render', 'pen'];
  assert.equal(similarity(a, b), similarity(b, a));
  assert.ok(similarity(a, b) > 0 && similarity(a, b) < 1);
  assert.equal(similarity(a, a), 1);
  assert.equal(similarity([], a), 0);
});

// ---------------------------------------------------------------------------
// Per-tool output caps
// ---------------------------------------------------------------------------

test('caps: a chatty tool gets less window than a dense one', () => {
  assert.ok(resultCapFor('sysRun') < resultCapFor('fs_read'),
    'a build log and a source file are not equally worth their space');
  assert.ok(resultCapFor('fs_list') < resultCapFor('sysRun'));
  assert.equal(resultCapFor('some_tool_with_no_entry'), DEFAULT_RESULT_CAP);
  assert.equal(resultCapFor(''), DEFAULT_RESULT_CAP);
});

test('caps: lowering a cap never destroys bytes', () => {
  // The whole result is spilled to disk BEFORE it is shortened, and the notice
  // that replaces it names the path. That is what makes these numbers safe to
  // tune at all.
  const source = fs.readFileSync(new URL('../src/agentLoop.js', import.meta.url), 'utf8');
  const region = source.slice(source.indexOf('const MAX_RESULT_CHARS = resultCapFor'));
  assert.match(region.slice(0, 1600), /spillToolResult/,
    'the result is being truncated without being spilled first');
});

test('plan cache: a failure is remembered by CLASS, never by message', async () => {
  // `ok: false` alone cannot tell "this route is wrong" from "this moment was
  // wrong". The literature on caching negative traces supports storing the
  // failure; storing the MESSAGE would put paths, hostnames and keys in a
  // reusable cache, so only a closed-vocabulary token survives.
  const { failureClass } = await import('../src/planCache.js');

  assert.equal(failureClass({ error: 'ffmpeg: command not found' }), 'not_found');
  assert.equal(failureClass({ error: 'EACCES: permission denied, open /etc/hosts' }), 'permission');
  assert.equal(failureClass({ error: 'connect ECONNREFUSED 127.0.0.1:8080' }), 'network');
  assert.equal(failureClass({ error: 'Request timed out after 30s' }), 'timeout');
  assert.equal(failureClass({ exitCode: 1 }), 'exit_nonzero');
  assert.equal(failureClass(null), '');

  const step = toStep('sysRun', { action: 'probe' }, false, {
    error: 'sh: /Users/example/secret/tool: command not found',
    stderr: 'OPENAI_KEY=sk-live-xyz leaked into stderr'
  });
  assert.equal(step.why, 'not_found');
  assert.ok(!/local-user|secret|sk-live|OPENAI/.test(JSON.stringify(step)),
    'the error text leaked into the plan cache');
});

test('plan cache: the hint names the failure class so the lesson is actionable', () => {
  recordPlan({
    prompt: 'encode the rendered frames into a playable video',
    archetype: 'media',
    steps: [
      toStep('sysRun', { action: 'probe' }, false, { error: 'ffmpeg: command not found' }),
      toStep('blender_act', { action: 'render_animation' }, true)
    ]
  });

  const hint = renderPlanHint(lookupPlan({
    prompt: 'encode the rendered frames into a playable video', archetype: 'media' }));

  assert.match(hint, /FAILED last time \(not_found\)/,
    'the hint says a step failed but not what kind of failure it was');
});
