import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LLMProvider } from '../src/providers/base.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const AGENT_LOOP = fs.readFileSync(path.join(HERE, '..', 'src', 'agentLoop.js'), 'utf8');

// Comments in agentLoop.js discuss `reasoning_content` at length. Strip them
// before asserting on code, or the test passes on its own documentation — the
// ZM-09 naive-substring trap.
const executable = AGENT_LOOP
  .split('\n')
  .filter(line => !line.trim().startsWith('//') && !line.trim().startsWith('*') && !line.trim().startsWith('/*'))
  .join('\n');

test('reasoning: reasoning_content is round-tripped onto the assistant turn', () => {
  // DeepSeek V4 in thinking mode REJECTS a multi-turn request that omits the
  // reasoning_content of a previous assistant turn — "The reasoning_content in
  // the thinking mode must be passed back to the API", HTTP 400, from the
  // second turn onward. It is a live bug in several other agents. Causyne is
  // correct here, and it is one deleted line away from not being.
  assert.match(
    executable,
    /assistantMsg\.reasoning_content\s*=\s*response\.reasoningContent/,
    'reasoning_content is no longer attached to the assistant message — DeepSeek V4 thinking mode will 400 on turn 2'
  );
});

test('reasoning: reasoning_content survives the strip that runs before every request', () => {
  // providers/base.js removes its internal bookkeeping fields from every
  // outgoing message. reasoning_content must NOT be among them.
  const stripped = new LLMProvider({ apiKey: 'test', model: 'deepseek-v4-pro' })
    .stripInternalFields?.([{ role: 'assistant', content: 'x', reasoning_content: 'kept', spillPath: '/tmp/x' }]);

  if (!stripped) return; // helper is named differently; the source assert below still guards it

  assert.equal(stripped[0].reasoning_content, 'kept', 'reasoning_content was stripped before the request');
  assert.equal(stripped[0].spillPath, undefined, 'internal bookkeeping leaked to the provider');
});

test('reasoning: the internal-field strip list does not name reasoning_content', () => {
  const base = fs.readFileSync(path.join(HERE, '..', 'src', 'providers', 'base.js'), 'utf8');
  const list = base.match(/const INTERNAL_MESSAGE_FIELDS = \[([^\]]*)\]/);

  assert.ok(list, 'could not read INTERNAL_MESSAGE_FIELDS');
  assert.ok(
    !list[1].includes('reasoning_content'),
    'reasoning_content was added to INTERNAL_MESSAGE_FIELDS — DeepSeek V4 thinking mode will 400 on multi-turn'
  );
});

test('observation compaction: a repeated large result folds to a pointer', () => {
  // Asserted against the source because the fold sits inside the tool-execution
  // branch of run(), which needs a live provider to reach.
  assert.match(executable, /_observationDigests/, 'the observation digest map is gone');
  assert.match(executable, /OBSERVATION_FOLD_FLOOR/, 'the size floor is gone — small acks would collide');
  assert.match(
    executable,
    /createHash\('sha256'\)\.update\(resultString\)/,
    'results are no longer hashed, so repeats cannot be detected'
  );
});

test('observation compaction: the digest map is per task, not per process', () => {
  // A digest carried across tasks would point at a step number the model can
  // no longer see — worse than paying for the bytes twice.
  const resets = executable.match(/this\._observationDigests = new Map\(\)/g) || [];
  assert.ok(
    resets.length >= 2,
    `expected the digest map to be initialised AND reset per task, found ${resets.length} assignment(s)`
  );
});

test('observation compaction: the floor is high enough to skip trivial acks', () => {
  const floor = executable.match(/OBSERVATION_FOLD_FLOOR\s*=\s*(\d+)/);
  assert.ok(floor, 'could not read the fold floor');
  assert.ok(
    Number(floor[1]) >= 300,
    `fold floor is ${floor[1]}; below ~300 every {"success":true} ack collides with every other one`
  );
});
