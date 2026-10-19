import test from 'node:test';
import assert from 'node:assert/strict';

import { TOOL_DEFINITIONS } from '../src/tools/registry.js';
import { resolveActiveTools, PACK_NAMES, PACKS, RESIDENT_TOOLS, CORE_TOOLS } from '../src/toolPacks.js';

const names = (packs, order, tools = [], options = {}) =>
  resolveActiveTools(TOOL_DEFINITIONS, new Set(packs), new Set(tools), order, options).map(d => d.name);

const resident = (packs, order, tools) => names(packs, order, tools, { residentOnly: true });
const tokensOf = (list) =>
  resolveActiveTools(TOOL_DEFINITIONS, new Set(), new Set(), null, { residentOnly: list })
    .reduce((sum, tool) => sum + Math.round(JSON.stringify(tool).length / 4), 0);

// WHY THIS FILE EXISTS
//
// Anthropic's prompt cache is a prefix match, and `tools` renders BEFORE
// `system`, so the tool array is upstream of everything. When the array grows
// mid-task the cache_control breakpoint moves — but the API does not simply
// miss. It "walks backward one block at a time, checking whether the prefix
// hash at each earlier position matches something already in the cache",
// within a 20-block lookback window.
//
// That backward walk only finds anything if the array is APPEND-ONLY: the
// tools present before an unlock must still occupy the same positions, in the
// same order, afterwards. `resolveActiveTools` guarantees this today (core
// first in CORE_TOOLS order, then pack tools grouped by unlock sequence). It is
// an invariant nothing states out loud, and a plausible future change —
// sorting the whole list alphabetically, or ranking packs by relevance — would
// silently break the cache on EVERY pack unlock without failing any test.
//
// Investigated and NOT changed: moving the breakpoint to the core boundary.
// Content after the last breakpoint is never cached, so that would reprocess
// every pack tool on every step — far worse than one miss per unlock.

test('tool order: unlocking a pack appends and never reorders', () => {
  const before = names([]);

  for (const pack of PACK_NAMES) {
    const after = names([pack], [pack]);
    assert.deepEqual(
      after.slice(0, before.length), before,
      `unlocking "${pack}" reordered the existing prefix — the cache lookback can no longer match it`
    );
    assert.ok(after.length > before.length, `unlocking "${pack}" added no tools`);
  }
});

test('tool order: a second unlock preserves the prefix the first produced', () => {
  const first = names(['web'], ['web']);
  const second = names(['web', 'media'], ['web', 'media']);

  assert.deepEqual(
    second.slice(0, first.length), first,
    'the second unlock rewrote the prefix the first one established'
  );
});

test('tool order: resolution is deterministic for identical input', () => {
  const a = names(['web', 'media'], ['web', 'media']);
  const b = names(['web', 'media'], ['web', 'media']);
  assert.deepEqual(a, b, 'same input produced a different order — the cache would miss every step');
});

test('residentOnly: withholds the non-resident core and saves the measured tokens', () => {
  const full = tokensOf(false);
  const lean = tokensOf(true);

  assert.equal(resident([]).length, RESIDENT_TOOLS.length, 'resident set size drifted from RESIDENT_TOOLS');
  assert.ok(lean <= 1100, `resident tool payload is ${lean} tok, budget is 1,100 (docs B1 "done when")`);
  assert.ok(
    full - lean >= 2000,
    `expected ≥2,000 tok saved on a no-pack turn, measured ${full - lean} (full ${full}, resident ${lean})`
  );
});

test('residentOnly: tool_search is resident, or nothing is discoverable', () => {
  // Withholding schemas is only safe because the model can ask for them back.
  // Drop tool_search from the resident set and the agent is genuinely crippled.
  assert.ok(RESIDENT_TOOLS.includes('tool_search'), 'tool_search must ship in every request');
  assert.ok(resident([]).includes('tool_search'));
});

test('residentOnly: every resident tool is a real core tool', () => {
  for (const name of RESIDENT_TOOLS) {
    assert.ok(CORE_TOOLS.includes(name), `${name} is in RESIDENT_TOOLS but not in CORE_TOOLS`);
  }
});

test('residentOnly: the resident head never moves when anything unlocks', () => {
  // The reason unlocked core tools are APPENDED rather than slotted back into
  // their CORE_TOOLS position. Slotting them in would insert into the middle of
  // the array and invalidate the cached prefix from that point on, on every
  // discovery — turning a token saving into a cache regression.
  const head = resident([]);

  const afterCoreUnlock = resident([], null, ['web_search']);
  assert.deepEqual(afterCoreUnlock.slice(0, head.length), head, 'a core-tool unlock moved the resident head');
  assert.ok(afterCoreUnlock.includes('web_search'), 'the unlocked core tool never became visible');

  const afterPackUnlock = resident(['web'], ['web'], ['web_search']);
  assert.deepEqual(afterPackUnlock.slice(0, head.length), head, 'a pack unlock moved the resident head');

  for (const pack of PACK_NAMES) {
    assert.deepEqual(resident([pack], [pack]).slice(0, head.length), head, `unlocking "${pack}" moved the resident head`);
  }
});

test('residentOnly: off by default, so the Anthropic path is untouched', () => {
  // Anthropic defers server-side, which is strictly better — no round trip.
  // resolveActiveTools must behave exactly as before when the flag is absent.
  assert.deepEqual(names([]), names([], null, [], { residentOnly: false }));
  assert.ok(names([]).length > RESIDENT_TOOLS.length, 'the default path stopped shipping the full core');
});

test('tool order: only the game pack exceeds the 20-block cache lookback', () => {
  // Documented so the number is not rediscovered by accident. A pack that adds
  // 20+ tools in one unlock pushes the previous cache entry outside the API's
  // 20-position backward walk, so that unlock costs a full prefix rewrite.
  // Packs at or under 19 stay inside the window and still hit.
  const LOOKBACK_BLOCKS = 20;
  const oversized = PACK_NAMES.filter(name => PACKS[name].length >= LOOKBACK_BLOCKS);

  assert.deepEqual(
    oversized, ['game'],
    'the set of packs that blow the cache lookback changed — re-measure the cost in docs/AGENT_TOKEN_ECONOMY_AND_EMBODIMENT.md B2'
  );
});
