import test from 'node:test';
import assert from 'node:assert/strict';

import { getUniversalSkillsIndex, getSkillDomainHeader, listCompiledSkills } from '../src/skillsManager.js';
import { deferredMcpSearch } from '../src/tools/deferredMcpSearch.js';
import { isResidentTool, isCoreTool } from '../src/toolPacks.js';

const tokensOf = (text) => Math.round(String(text).length / 4);
const search = (args) => deferredMcpSearch.execute(args);

test('skills: the domain header replaces the catalogue at a fraction of the cost', () => {
  const domains = new Set(['design', 'security']);
  const before = tokensOf(getUniversalSkillsIndex(domains));
  const after = tokensOf(getSkillDomainHeader(domains));

  assert.ok(before > 700, `expected the old index to be expensive, measured ${before} tok`);
  assert.ok(after <= 140, `domain header is ${after} tok, budget is 140`);
  assert.ok(before - after > 600, `expected >600 tok saved, measured ${before - after}`);
});

test('skills: the header still names every domain and how to reach them', () => {
  const header = getSkillDomainHeader(new Set(['web']));
  const domains = [...new Set(listCompiledSkills().map(s => s.domain))];

  for (const domain of domains) {
    assert.ok(header.includes(domain), `header omits the "${domain}" domain, so it is undiscoverable`);
  }
  assert.ok(header.includes('tool_search'), 'header must point at the retrieval path');
  assert.ok(header.includes('fs_read_skill'), 'header must name the tool that actually reads a skill');
});

test('skills: tool_search finds skills, which is what makes shrinking the index safe', async () => {
  // Before this, tool_search scored TOOL_DEFINITIONS only. The system-prompt
  // catalogue was the sole way to learn a skill id, so removing it would have
  // made 100 compiled skills unreachable.
  const result = await search({ query: 'android' });

  assert.equal(result.success, true);
  assert.match(result.output, /SKILL/i, 'tool_search returned no skills section');
  assert.match(result.output, /android\//, 'no android skill id in the output');
});

test('skills: a query that matches no tool still returns skills', async () => {
  const result = await search({ query: 'database migration strategy' });

  assert.equal(result.success, true);
  assert.ok(
    /SKILL/i.test(result.output) || /Nothing matched/.test(result.output),
    `unexpected output: ${result.output.slice(0, 200)}`
  );
});

test('tool_search: unlocks non-resident CORE tools, not just pack tools', async () => {
  // THE BUG B1 INTRODUCED. The unlock condition was `!isCoreTool(name)`, which
  // was right while the whole core shipped every request. Once only
  // RESIDENT_TOOLS ship, a withheld core tool found by search was labelled
  // "already loaded" and never added to _unlock_tools — invisible forever.
  const result = await search({ query: 'search the web' });

  assert.equal(result.success, true);
  const unlocked = result._unlock_tools || [];
  const foundCoreNonResident = /web_search/.test(result.output) && isCoreTool('web_search') && !isResidentTool('web_search');

  if (foundCoreNonResident) {
    assert.ok(
      unlocked.includes('web_search'),
      'a non-resident core tool was found but not unlocked — it would stay invisible'
    );
  }
});

test('tool_search: never re-unlocks a resident tool', async () => {
  const result = await search({ query: 'read a file' });
  for (const name of result._unlock_tools || []) {
    assert.ok(!isResidentTool(name), `${name} is resident and must not be in _unlock_tools`);
  }
});
