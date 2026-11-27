import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderEpisodicContext } from '../src/memory/contextBudget.js';
import { redactTextSecrets } from '../src/providers/byokHttp.js';

test('invalid observation timestamps use the recent fallback', () => {
  const observation = {
    id: 1, taskId: 'task', workspace: '/workspace', project: 'fixture', type: 'bugfix',
    title: 'Recovered', subtitle: '', narrative: '', facts: [], concepts: [],
    filesRead: [], filesModified: [], toolName: '', createdAtEpochMs: NaN,
    reinforcedAtEpochsMs: [], reinforcementCount: 0
  };
  const input = { project: 'fixture', observations: [observation], summaries: [] };
  assert.match(renderEpisodicContext(input), /\(recent\)/);
  assert.doesNotMatch(renderEpisodicContext(input), /NaN/);
  assert.match(renderEpisodicContext({ ...input, observations: [{ ...observation, createdAtEpochMs: 0 }] }), /1970-01-01 00:00/);
});

test('malformed Unicode cannot break explicit secret redaction', () => {
  const secret = 'fixture-' + String.fromCharCode(0xd800) + '-secret';
  const other = 'fixture with spaces';
  const result = redactTextSecrets(secret + ' ' + encodeURIComponent(other), [secret, other], { sanitizeTerminal: false });
  assert.equal(result, '[REDACTED] [REDACTED]');
});
