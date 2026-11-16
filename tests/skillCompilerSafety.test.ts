import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const compiler = fs.readFileSync(new URL('../scripts/compile_skills.js', import.meta.url), 'utf8');

function runWith(names: string[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-skill-compiler-'));
  try {
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'scripts', 'compile_skills.js'), compiler);
    for (const name of names) {
      const target = path.join(root, 'native-skills', 'testing', name);
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'SKILL.md'),
        '---\\nname: ' + name + '\\ndescription: test skill\\n---\\n# Valid fixture\\n');
    }
    const run = spawnSync(process.execPath, [path.join(root, 'scripts', 'compile_skills.js')],
      { cwd: root, encoding: 'utf8', timeout: 5000 });
    const generated = fs.existsSync(path.join(root, 'src', 'compiledSkills.js'))
      ? fs.readFileSync(path.join(root, 'src', 'compiledSkills.js'), 'utf8') : '';
    return { status: run.status, output: run.stdout + run.stderr, generated };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('compiler accepts normal skill slugs without changing export shape', () => {
  const result = runWith(['unit-testing']);
  assert.equal(result.status, 0, result.output);
  assert.match(result.generated, /"unit-testing":/);
  assert.match(result.generated, /export const COMPILED_SKILLS/);
});

test('compiler rejects prototype-pollution skill frontmatter', () => {
  const result = runWith(['__proto__']);
  assert.notEqual(result.status, 0);
  assert.match(result.output, /Invalid skill name: __proto__/);
});

test('compiler fails closed on invalid case or path-like skill identifiers', () => {
  for (const name of ['UPPER', 'bad.name']) {
    const result = runWith([name]);
    assert.notEqual(result.status, 0);
    assert.match(result.output, /Invalid skill name:/);
  }
});
