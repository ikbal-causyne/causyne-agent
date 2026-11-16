import test from 'node:test';
import assert from 'node:assert/strict';
import { VERIFICATION_SKILLS } from '../src/verification/skillCatalog.js';
import { listCompiledSkills, readCompiledSkill, getSkillDomainHeader } from '../src/skillsManager.js';
import readSkillTool from '../src/tools/readNativeSkill.js';

test('verified workflows are discoverable as native Causyne skills', async () => {
  const entries = listCompiledSkills().filter(s => s.domain === 'verification');
  assert.equal(entries.length, Object.keys(VERIFICATION_SKILLS).length);
  assert.ok(entries.some(s => s.id === 'runtime-verification'));
  assert.ok(entries.some(s => s.id === 'formal-verification'));
  for (const entry of entries) {
    assert.equal(entry.source, 'native');
    const content = readCompiledSkill('verification', entry.id);
    assert.match(content, /Done when:/);
    assert.match(content, /## Verification/);
    const response = await readSkillTool.execute({ skill_id: 'verification/' + entry.id });
    assert.equal(response.success, true);
  }
  assert.match(getSkillDomainHeader(['verification']), /verification/);
});

test('new skills never impersonate Cursor-only commands or claim proof without a check', () => {
  const text = Object.values(VERIFICATION_SKILLS).map(v => v.content).join('\n');
  assert.doesNotMatch(text, /(?:^|\n)\s*[$>]\s*app aria-click|guaranteed proof|100% tested/im);
  assert.match(text, /PTY/);
  assert.match(text, /TLA\+/);
});
