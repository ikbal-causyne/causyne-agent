// A skill must reach the model, not the terminal.
//
// The reported failure, and it was total: `/skills <id> <instruction>` printed
// the whole SKILL.md into the terminal and called `continue`. The body never
// entered a request, everything typed after the id was discarded, and no API
// call was made at all. "Activating" a skill was a document viewer wearing a
// command's clothes — the agent behaved exactly as if nothing had happened.
//
// These tests pin the three links in the chain that was broken:
//   1. the command produces a runnable invocation carrying the body and the task
//   2. the loop puts that body into the system messages it sends
//   3. it applies to that turn only

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { handleInput } from '../src/commands.js';
import { listCompiledSkills } from '../src/skillsManager.js';
import { skillSystemMessage } from '../src/agentLoop.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..');

describe('invoking a skill produces something runnable', () => {
  const someSkill = () => listCompiledSkills()[0];

  test('the invocation carries the body and the instruction', async () => {
    const skill = someSkill();
    const result = await handleInput(
      `/skills ${skill.domain}/${skill.id} please produce this`, { surface: 'terminal' }
    );
    assert.equal(result.effect, 'invoke-skill');
    assert.equal(result.skill.id, `${skill.domain}/${skill.id}`);
    assert.ok(result.skill.content.includes('Done when:'), 'the real body must travel with it');
    assert.equal(result.instruction, 'please produce this');
  });

  test('an invocation with no instruction still runs', async () => {
    const skill = someSkill();
    const result = await handleInput(`/skills ${skill.domain}/${skill.id}`, { surface: 'terminal' });
    assert.equal(result.effect, 'invoke-skill');
    assert.equal(result.instruction, '', 'the caller supplies a default task for this case');
  });

  test('reading is a separate, non-running action', async () => {
    const skill = someSkill();
    const result = await handleInput(`/skills ${skill.domain}/${skill.id} --show`, { surface: 'terminal' });
    assert.equal(result.effect, undefined);
    assert.ok(!result.output.startsWith('---'), 'the frontmatter is routing data, not prose');
  });
});

describe('the invoked skill reaches the request', () => {
  // The link that was missing entirely. skillSystemMessage() is exported from
  // agentLoop.js precisely so this can be asserted on what it PRODUCES rather
  // than by grepping the source and hoping.

  test('a skill becomes a system message carrying its whole body', async () => {
    const skill = listCompiledSkills()[0];
    const invoked = await handleInput(`/skills ${skill.domain}/${skill.id}`, { surface: 'terminal' });

    const messages = skillSystemMessage(invoked.skill);
    assert.ok(Array.isArray(messages) && messages.length === 1);

    const [message] = messages;
    assert.equal(message.role, 'system', 'a procedure the agent must follow is system-level');
    assert.ok(message.content.includes(invoked.skill.content),
      'the WHOLE body must be sent — an id or a summary tells the model nothing');
    assert.ok(message.content.includes(`${skill.domain}/${skill.id}`),
      'the model should know which skill it was handed');
  });

  test('it frames the skill as a method to carry out, not a document to echo', () => {
    const [message] = skillSystemMessage({ id: 'x/y', content: 'body' });
    assert.match(message.content, /not a document to summarise back/i,
      'without this the model tends to reply with a description of the skill');
    assert.match(message.content, /safety rules or the workspace boundaries, those win/i,
      'an injected body must not be able to outrank the safety rules');
  });

  test('it anchors the cache instead of invalidating the prefix', () => {
    const [message] = skillSystemMessage({ id: 'x/y', content: 'body' });
    assert.equal(message.cacheAnchor, true,
      'the skill is stable for the whole task; re-sending it uncached on every step is pure cost');
  });

  test('no skill produces no message at all', () => {
    assert.equal(skillSystemMessage(null), null);
    assert.equal(skillSystemMessage(undefined), null);
    assert.equal(skillSystemMessage({ id: 'x/y', content: '   ' }), null,
      'an empty body must not add a system message that says nothing');
    assert.equal(skillSystemMessage({ id: 'x/y' }), null);
  });

  test('the loop assembles it into the messages it sends', () => {
    const loop = fs.readFileSync(path.join(repoRoot, 'src', 'agentLoop.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');

    const block = loop.slice(
      loop.indexOf('const systemMessages = ['),
      loop.indexOf('];', loop.indexOf('const systemMessages = ['))
    );
    assert.match(block, /skillSystemMessage\(this\.activeSkill\)/,
      'building the message is useless if it is never put in the request');
    assert.match(loop, /this\.activeSkill\s*=\s*null/, 'the field must be initialised');
  });

  test('cliMode attaches the skill and falls through to the turn', () => {
    const cli = fs.readFileSync(path.join(repoRoot, 'src', 'cliMode.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');

    const branch = cli.slice(cli.indexOf("effect === 'invoke-skill'"));
    const body = branch.slice(0, branch.indexOf('} else'));
    assert.match(body, /loop\.activeSkill\s*=/, 'the loop must be told which skill is active');
    assert.match(body, /task\s*=/, 'the instruction must become the task');
    assert.ok(!/continue;/.test(body),
      'a `continue` here is the original bug: it returns to the prompt without running a turn');
  });

  test('the skill is cleared after the turn', () => {
    const cli = fs.readFileSync(path.join(repoRoot, 'src', 'cliMode.js'), 'utf8');
    assert.match(cli, /loop\.activeSkill\s*=\s*null/,
      'one turn, one skill — an invocation must not silently steer every later message');
  });
});

describe('the skill index the agent always sees', () => {
  test('descriptions are injected, bodies are not', async () => {
    const { getUniversalSkillsIndex } = await import('../src/skillsManager.js');
    const index = getUniversalSkillsIndex(['devops', 'security']);
    assert.ok(index.length > 0, 'the agent must know the library exists');
    assert.ok(!index.includes('Done when:'),
      'bodies must NOT be injected wholesale — that is what fs_read_skill and invocation are for');
    assert.match(index, /fs_read_skill/,
      'the index must tell the model how to pull a body when it needs one');
  });
});
