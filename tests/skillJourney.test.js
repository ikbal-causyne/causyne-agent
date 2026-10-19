// The journey a user actually takes, end to end.
//
// Every bug in this file was one I shipped, and every one of them survived a
// green suite because the tests checked the pieces and never the path between
// them. `applyCompletion` was correct in isolation; `handleInput` was correct in
// isolation; typing a prefix, accepting it and then asking a question produced
// `/skills python/data-processing-pipelineswhy my data is like this ?`.
//
// So these tests walk the whole flow: type, accept, keep typing, run.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { suggest, applyCompletion } from '../src/tui/completion.js';
import { handleInput } from '../src/commands.js';
import { listCompiledSkills } from '../src/skillsManager.js';

/** Type `text`, accept the top suggestion, and return the resulting line. */
function accept(text) {
  const trigger = suggest(text, text.length, { root: process.cwd() });
  assert.ok(trigger, `nothing was suggested for ${JSON.stringify(text)}`);
  return applyCompletion(text, text.length, trigger, trigger.items[0]).text;
}

describe('typing a prefix, accepting it, then asking a question', () => {
  test('the completed skill id does not fuse with what is typed next', async () => {
    // The reported bug, verbatim.
    const line = accept('/skills python/data-proc');
    assert.ok(line.endsWith(' '),
      `accepting a complete id must leave a separator; got ${JSON.stringify(line)}`);

    const asked = line + 'why my data is like this ?';
    const result = await handleInput(asked, { surface: 'terminal' });
    assert.equal(result.ok, true, result.output);
    assert.equal(result.effect, 'invoke-skill');
    assert.equal(result.instruction, 'why my data is like this ?');
  });

  test('the same journey through the slash menu', async () => {
    const line = accept('/docker');
    assert.ok(line.endsWith(' '), `got ${JSON.stringify(line)}`);

    const result = await handleInput(line + 'make one for this repo', { surface: 'terminal' });
    assert.equal(result.ok, true, result.output);
    assert.equal(result.effect, 'invoke-skill');
    assert.equal(result.instruction, 'make one for this repo');
  });

  test('accepting a DOMAIN leaves no space, so you can drill into it', () => {
    const line = accept('/skills dev');
    assert.ok(!line.endsWith(' '),
      'a domain is a place to descend into — the same rule file completion uses for a directory');
    const next = accept(line + '/');
    assert.match(next, /^\/skills [a-z-]+\/[a-z0-9-]+ $/,
      'and descending then completes to a full id, with its separator');
  });

  test('every skill in the library survives the round trip', async () => {
    // A spot check across domains rather than a single lucky example.
    const sample = listCompiledSkills().filter((_, index) => index % 17 === 0);
    assert.ok(sample.length >= 4, 'the sample must actually cover something');

    for (const skill of sample) {
      const id = `${skill.domain}/${skill.id}`;
      const line = accept(`/skills ${id.slice(0, id.length - 3)}`);
      const result = await handleInput(line + 'do the thing', { surface: 'terminal' });
      assert.equal(result.ok, true, `${id}: ${result.output}`);
      assert.equal(result.instruction, 'do the thing', `${id} lost the instruction`);
    }
  });
});

describe('no command silently swallows what you typed', () => {
  // The original failure was `/skills <id>` reading argv[0] and discarding the
  // rest. The same shape existed in two more branches I wrote afterwards.

  test('a domain with trailing text explains itself instead of listing', async () => {
    const result = await handleInput('/skills devops please help me', { surface: 'terminal' });
    assert.equal(result.ok, false,
      'silently listing the domain and dropping "please help me" is the bug, not the fix');
    assert.match(result.output, /is a domain, not a skill/);
    assert.match(result.output, /please help me/,
      'the suggested correction must carry what the user actually typed');
  });

  test('/skill rejects extra words rather than ignoring them', async () => {
    const result = await handleInput('/skill mine extra words', { surface: 'terminal' });
    assert.equal(result.ok, false);
    assert.match(result.output, /at most one target/);
  });

  test('/skill only completes what is valid in that position', () => {
    const text = '/skill ';
    const trigger = suggest(text, text.length, { root: process.cwd() });
    for (const item of trigger.items) {
      assert.ok(['new', 'mine', 'edit', 'rm'].includes(item.value),
        `${item.value} is offered as the first argument but is only valid as the second — `
        + 'accepting it produced "Unknown action"');
    }
  });
});
