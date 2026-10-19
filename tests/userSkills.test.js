// Skills the user owns — written by them, or written for them by the agent.
//
// The compiled library is one library for everybody, which is the right shape
// for what every developer needs and the wrong shape for what any particular
// one needs. These are the escape hatch: a house deploy runbook, a team review
// checklist, a correction to a shipped skill that does not match reality.
//
// Two threat surfaces are load-bearing here and each has tests of its own:
//
//   * A skill NAME becomes a path. Traversal, absolute paths, dotfiles and
//     device names must be unrepresentable, not merely filtered.
//   * A skill DESCRIPTION is injected verbatim into the system prompt, so a
//     file that arrived some other way is untrusted text.

import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  validateSegment, parseSkillId, writeUserSkill, deleteUserSkill,
  loadUserSkills, skillTemplate, MAX_SKILL_BYTES, MAX_USER_SKILLS
} from '../src/userSkills.js';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-user-skills-'));
after(() => { try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (e) {} });

const VALID = `---
name: release-checklist
description: Our release steps. Use when shipping to production.
---

# Release Checklist

## Workflow

1. Freeze the branch.
   - **Done when:** CI is green on the tag.

## Verification

- Error rate flat for ten minutes.
`;

beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
});

describe('a skill name is a path segment, and is treated as one', () => {
  test('traversal, absolute paths and device names are rejected', () => {
    for (const hostile of [
      '..', '../etc', '../../etc/passwd', '/etc/passwd', 'a/b',
      '.hidden', 'con', 'C:', 'name with spaces', 'UPPER', '-leading',
      'trailing ', 'x'.repeat(80), ''
    ]) {
      assert.ok(validateSegment(hostile), JSON.stringify(hostile) + ' must be rejected as a segment');
    }
  });

  test('ordinary names are accepted', () => {
    for (const good of ['team', 'release-checklist', 'a', 'v2', 'my-team-2024']) {
      assert.equal(validateSegment(good), null, good + ' should be a valid segment');
    }
  });

  test('an id must be exactly domain/name', () => {
    assert.ok(parseSkillId('../../etc/passwd').error);
    assert.ok(parseSkillId('onlyone').error);
    assert.ok(parseSkillId('a/b/c').error);
    assert.ok(parseSkillId('').error);
    assert.deepEqual(parseSkillId('team/release-checklist'), { domain: 'team', name: 'release-checklist' });
  });

  test('a hostile id cannot write outside the skills root', () => {
    for (const hostile of ['../escape', '..%2Fescape', 'team/../../escape']) {
      const result = writeUserSkill({ domain: hostile, name: 'x', content: VALID }, ROOT);
      assert.equal(result.ok, false, hostile + ' must not be writable');
    }
    const strays = fs.readdirSync(path.dirname(ROOT)).filter((entry) => entry.includes('escape'));
    assert.deepEqual(strays, [], 'nothing may be created beside the skills root');
  });
});

describe('writing a skill', () => {
  test('a skill without a description is refused', () => {
    const result = writeUserSkill({
      domain: 'team', name: 'x',
      content: '---\nname: x\n---\n# X\n**Done when:** ok\n## Verification\n- ok\n'
    }, ROOT);
    assert.equal(result.ok, false);
    assert.match(result.error, /description/,
      'the description is what the agent reads to decide relevance — a skill without one is unreachable');
  });

  test('an oversized skill is refused rather than truncated', () => {
    const huge = VALID + 'x'.repeat(MAX_SKILL_BYTES);
    const result = writeUserSkill({ domain: 'team', name: 'huge', content: huge }, ROOT);
    assert.equal(result.ok, false);
    assert.match(result.error, /limit/);
  });

  test('an existing skill is never silently replaced', () => {
    assert.equal(writeUserSkill({ domain: 'team', name: 'a', content: VALID }, ROOT).ok, true);
    const second = writeUserSkill({ domain: 'team', name: 'a', content: VALID }, ROOT);
    assert.equal(second.ok, false);
    assert.match(second.error, /already exists/);
    assert.equal(writeUserSkill({ domain: 'team', name: 'a', content: VALID, overwrite: true }, ROOT).ok, true);
  });

  test('the template it scaffolds satisfies the contract it teaches', () => {
    const body = skillTemplate('team', 'release-checklist');
    assert.match(body, /^---\n/);
    assert.match(body, /\*\*Done when:\*\*/);
    assert.match(body, /## Verification/);
  });
});

describe('loading skills', () => {
  test('a valid skill round-trips', () => {
    writeUserSkill({ domain: 'team', name: 'release-checklist', content: VALID }, ROOT);
    const { skills } = loadUserSkills(ROOT);
    assert.equal(skills.length, 1);
    assert.equal(skills[0].domain, 'team');
    assert.equal(skills[0].id, 'release-checklist');
    assert.equal(skills[0].source, 'user');
    assert.match(skills[0].description, /Use when shipping/);
  });

  test('one broken skill does not stop the rest from loading', () => {
    writeUserSkill({ domain: 'team', name: 'good', content: VALID }, ROOT);
    // A file with no description, written directly — exactly how a hand-edited
    // or restored file arrives, bypassing the writer's checks.
    fs.mkdirSync(path.join(ROOT, 'team', 'broken'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'team', 'broken', 'SKILL.md'), '# no frontmatter\n');

    const { skills, problems } = loadUserSkills(ROOT);
    assert.equal(skills.length, 1, 'the good skill must still load');
    assert.equal(problems.length, 1, 'and the broken one must be reported, not swallowed');
    assert.match(problems[0], /broken/);
  });

  test('a directory that is not a valid name is skipped and reported', () => {
    fs.mkdirSync(path.join(ROOT, 'Bad Domain', 'x'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'Bad Domain', 'x', 'SKILL.md'), VALID);
    const { skills, problems } = loadUserSkills(ROOT);
    assert.equal(skills.length, 0);
    assert.ok(problems.some((problem) => /Bad Domain/.test(problem)));
  });

  test('an oversized file on disk is skipped, not loaded into the prompt', () => {
    fs.mkdirSync(path.join(ROOT, 'team', 'huge'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'team', 'huge', 'SKILL.md'), VALID + 'x'.repeat(MAX_SKILL_BYTES));
    const { skills, problems } = loadUserSkills(ROOT);
    assert.equal(skills.length, 0);
    assert.ok(problems.some((problem) => /exceeds/.test(problem)));
  });

  test('a symlink is refused — it is the way out of the directory', () => {
    fs.mkdirSync(path.join(ROOT, 'team', 'link'), { recursive: true });
    const secret = path.join(ROOT, 'secret.md');
    fs.writeFileSync(secret, VALID);
    try {
      fs.symlinkSync(secret, path.join(ROOT, 'team', 'link', 'SKILL.md'));
    } catch (e) {
      return; // no symlink support here; the guard is still in place
    }
    const { skills } = loadUserSkills(ROOT);
    assert.equal(skills.length, 0, 'a symlinked SKILL.md must not be followed');
  });

  test('control characters cannot reach the system prompt through a description', () => {
    const ESC = String.fromCharCode(27);
    const NUL = String.fromCharCode(0);
    fs.mkdirSync(path.join(ROOT, 'team', 'nasty'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, 'team', 'nasty', 'SKILL.md'),
      '---\nname: nasty\ndescription: clean' + ESC + '[2Jwiped' + NUL + 'text\n---\n'
      + '# X\n**Done when:** ok\n## Verification\n- ok\n');
    const { skills } = loadUserSkills(ROOT);
    assert.equal(skills.length, 1);
    assert.ok(!skills[0].description.includes(ESC), 'an escape must never reach the prompt');
    assert.ok(!skills[0].description.includes(NUL));
  });

  test('the library is bounded', () => {
    assert.ok(MAX_USER_SKILLS > 0 && MAX_USER_SKILLS <= 1000,
      'an unbounded user library would exhaust the context window it feeds');
  });

  test('a missing directory is simply an empty library', () => {
    const { skills, problems } = loadUserSkills(path.join(ROOT, 'does-not-exist'));
    assert.deepEqual(skills, []);
    assert.deepEqual(problems, []);
  });
});

describe('removing a skill', () => {
  test('a user skill can be removed; anything else cannot', () => {
    writeUserSkill({ domain: 'team', name: 'a', content: VALID }, ROOT);
    assert.equal(deleteUserSkill('team', 'a', ROOT).ok, true);
    assert.equal(deleteUserSkill('team', 'a', ROOT).ok, false, 'removing twice must fail cleanly');
    assert.equal(deleteUserSkill('..', 'x', ROOT).ok, false, 'traversal must not reach rm');
  });
});
