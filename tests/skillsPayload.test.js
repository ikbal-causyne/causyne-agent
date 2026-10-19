// The compiled skills payload must carry PRODUCT skills only.
//
// Private operating documents are not product skills and must never be compiled
// into the runtime payload. This test inspects the readable generated data rather
// than assuming an encoded payload provides confidentiality.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..');

import { COMPILED_SKILLS } from '../src/compiledSkills.js';
function decodedPayload() { return JSON.stringify(COMPILED_SKILLS); }

const DOCTRINE_MARKERS = [
  'MAL-2026', 'Zero-Malware mandate', 'THE GREAT SOCKET.DEV',
  'Dynamic Payload Obfuscation', 'highly guarded trade secrets',
  'CRITICAL DIRECTIVE FOR ALL AI AGENTS'
];

describe('the compiled skills payload ships no internal doctrine', () => {
  test('no agent-docs (or other doctrine) domain is present', () => {
    const data = JSON.parse(decodedPayload());
    const forbidden = ['agent-docs', 'agent_docs', 'doctrine', 'internal'];
    for (const domain of forbidden) {
      assert.ok(!(domain in data), `the "${domain}" domain must never be compiled into the agent`);
    }
    // Positive: the real product domains are still here.
    assert.ok(Object.keys(data).length > 0, 'product skills must still compile');
  });

  test('no doctrine marker survives anywhere in the decoded payload', () => {
    const blob = decodedPayload();
    for (const marker of DOCTRINE_MARKERS) {
      assert.ok(!blob.includes(marker),
        `the doctrine marker ${JSON.stringify(marker)} leaked into the shipped skills payload`);
    }
  });

  test('the doctrine files are not present under native-skills/', () => {
    const forbidden = path.join(repoRoot, 'native-skills', 'agent-docs');
    assert.ok(!fs.existsSync(forbidden),
      'native-skills/agent-docs/ must not exist — it is developer doctrine, not a product skill');
  });
});

// ---------------------------------------------------------------------------
// The skills must be real, and they must be in English.
// ---------------------------------------------------------------------------
//
// Every description is injected verbatim into the system prompt by
// getUniversalSkillsIndex(), so a description written in another language is not
// a cosmetic problem — it steers the model in that language on every single
// turn. The shipped payload once carried five skills whose descriptions read
// "Panduan membuat Dockerfile multi-stage yang super ringan dan aman."
//
// The contract each skill must meet is openclaw's (skills/skill-creator):
// frontmatter with a name and a model-facing description carrying the routing
// condition, and a body whose steps each close with a checkable criterion.

// Indonesian function words, as whole words. Chosen because they are frequent,
// short, and have no English homographs — matching on a substring would flag
// "yang" inside a proper noun or "dari" inside "darling".
const NON_ENGLISH_MARKERS = [
  'yang', 'untuk', 'dengan', 'agar', 'tidak', 'adalah', 'pada', 'dari',
  'kamu', 'harus', 'bisa', 'akan', 'ini', 'itu', 'atau', 'juga'
];

const MINIMUM_SKILLS = 100;

function skillEntries() {
  const data = JSON.parse(decodedPayload());
  const entries = [];
  for (const [domain, skills] of Object.entries(data)) {
    for (const [id, skill] of Object.entries(skills)) entries.push({ domain, id, skill });
  }
  return entries;
}

describe('the compiled skills are real product skills in English', () => {
  test(`at least ${MINIMUM_SKILLS} skills are compiled`, () => {
    const entries = skillEntries();
    assert.ok(entries.length >= MINIMUM_SKILLS,
      `only ${entries.length} skills are compiled; the library target is ${MINIMUM_SKILLS}`);
  });

  test('no skill carries a non-English function word', () => {
    const offenders = [];
    for (const { domain, id, skill } of skillEntries()) {
      const text = `${skill.name} ${skill.description} ${skill.content}`;
      for (const marker of NON_ENGLISH_MARKERS) {
        if (new RegExp(`\\b${marker}\\b`, 'i').test(text)) {
          offenders.push(`${domain}/${id} (${marker})`);
          break;
        }
      }
    }
    assert.deepEqual(offenders, [],
      `descriptions are injected into the system prompt verbatim, so a non-English one steers the model: ${offenders.join(', ')}`);
  });

  test('every skill has a name and a routing description', () => {
    const thin = [];
    for (const { domain, id, skill } of skillEntries()) {
      if (!skill.name || !skill.description) { thin.push(`${domain}/${id} (missing)`); continue; }
      // A description shorter than this cannot carry both what the skill does
      // and when to reach for it, which is the whole point of the index.
      if (skill.description.length < 40) thin.push(`${domain}/${id} (${skill.description.length} chars)`);
    }
    assert.deepEqual(thin, [], `skills with no usable routing description: ${thin.join(', ')}`);
  });

  test('every skill body carries a checkable completion criterion', () => {
    const missing = skillEntries()
      .filter(({ skill }) => !skill.content.includes('Done when:'))
      .map(({ domain, id }) => `${domain}/${id}`);
    assert.deepEqual(missing, [],
      `a skill without a "Done when:" criterion is documentation, not a procedure: ${missing.join(', ')}`);
  });

  test('every skill body has a verification section', () => {
    const missing = skillEntries()
      .filter(({ skill }) => !/##\s+Verification/i.test(skill.content))
      .map(({ domain, id }) => `${domain}/${id}`);
    assert.deepEqual(missing, [], `skills with no verification section: ${missing.join(', ')}`);
  });

  test('the index injected into the system prompt stays bounded', async () => {
    // 100 skills is roughly 250 KB of markdown. Injecting every description of
    // every detected domain would spend the context window on an index before
    // the task was read — which is why the index is capped and bodies load on
    // demand through fs_read_skill.
    const { getUniversalSkillsIndex, MAX_INDEXED_SKILLS } =
      await import('../src/skillsManager.js');
    const everyDomain = Object.keys(JSON.parse(decodedPayload()));
    const index = getUniversalSkillsIndex(everyDomain);
    const entries = (index.match(/^- \*\*/gm) || []).length;
    assert.ok(entries <= MAX_INDEXED_SKILLS,
      `the injected index carried ${entries} entries, above the ${MAX_INDEXED_SKILLS} cap`);
    assert.ok(index.length < 16000,
      `the injected index is ${index.length} characters; it must stay a routing table, not a library`);
  });

  test('detection reaches every compiled domain', async () => {
    // A skill in a domain nothing can detect is compiled into the artefact and
    // unreachable. Detection named four domains while the library had fifteen.
    const { default: fs } = await import('node:fs');
    const source = fs.readFileSync(path.join(repoRoot, 'src', 'skillsManager.js'), 'utf8');
    const unreachable = Object.keys(JSON.parse(decodedPayload()))
      .filter((domain) => !new RegExp(`['"\`]?${domain}['"\`]?\\s*:`).test(source));
    assert.deepEqual(unreachable, [],
      `these domains have skills but no detection rule: ${unreachable.join(', ')}`);
  });
});
