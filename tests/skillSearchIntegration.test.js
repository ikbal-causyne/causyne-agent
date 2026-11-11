import { test } from 'node:test';
import { adversarialRegex } from './helpers/adversarialRegexFixtures.js';
import assert from 'node:assert/strict';

import { deferredMcpSearch } from '../src/tools/deferredMcpSearch.js';
import { MAX_TOOL_SEARCH_QUERY } from '../src/skills/skillSearchSafety.js';

// Exercise the *actual* catalog and model-facing tool result after TypeScript build.
test('skill discovery still provides concrete skill IDs, not invented tool names', async () => {
  const result = await deferredMcpSearch.execute({ query: 'android debugging and testing' });
  assert.equal(result.success, true);
  assert.match(result.output, /SKILL|android\//i);
});

test('adversarial regex-shaped queries remain a literal search, not a RegExp program', async () => {
  const result = await deferredMcpSearch.execute({ query: adversarialRegex.nestedPlus });
  assert.equal(result.success, true);
});

test('very large search query fails before model-facing schema expansion', async () => {
  const result = await deferredMcpSearch.execute({ query: 'x'.repeat(MAX_TOOL_SEARCH_QUERY + 1) });
  assert.equal(result.success, false);
  assert.match(result.error, /exceeds/);
});

test('skill search output labels provenance when skills match', async () => {
  const result = await deferredMcpSearch.execute({ query: 'database safe migrations' });
  assert.equal(result.success, true);
  if (result.output.includes('SKILLS')) {
    assert.match(result.output, /\[(native|user|plugin)\]/);
  }
});
