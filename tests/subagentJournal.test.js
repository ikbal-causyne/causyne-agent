import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  completeSubagentJournal,
  failSubagentJournal,
  readSubagentJournal,
  startSubagentJournal,
  subagentJournalFile
} from '../src/subagentJournal.js';

function record(id) {
  return {
    subagentId: id,
    name: 'reviewer',
    prompt: 'Inspect the requested module.',
    profile: 'reviewer',
    toolScope: ['fs_read', 'fs_search'],
    maxSteps: 8,
    maxTokens: 12_000
  };
}

test('subagent sidechains: completed work projects from append-only JSONL', () => {
  const id = 'sub_test_complete';
  assert.equal(startSubagentJournal(record(id)), true);
  const file = subagentJournalFile(id);
  const before = fs.readFileSync(file);
  assert.equal(completeSubagentJournal(id, [
    { role: 'user', content: 'Inspect it.' },
    { role: 'assistant', content: 'Verified one finding.' }
  ], { summary: 'Verified one finding.', stepsCompleted: 2 }), true);
  const after = fs.readFileSync(file);
  assert.deepEqual(after.subarray(0, before.length), before, 'completion rewrote the journal prefix');

  const projected = readSubagentJournal(id);
  assert.equal(projected.status, 'completed');
  assert.equal(projected.messages.length, 2);
  assert.equal(projected.result.summary, 'Verified one finding.');
});

test('subagent sidechains: a torn final append retains prior complete events', () => {
  const id = 'sub_test_torn';
  assert.equal(startSubagentJournal(record(id)), true);
  fs.appendFileSync(subagentJournalFile(id), '{"version":1,"type":"message.recorded"');
  const projected = readSubagentJournal(id);
  assert.equal(projected.status, 'running');
  assert.equal(projected.messages.length, 0);
});

test('subagent sidechains: failures are recorded without inventing a result', () => {
  const id = 'sub_test_failed';
  assert.equal(startSubagentJournal(record(id)), true);
  assert.equal(failSubagentJournal(id, 'provider unavailable'), true);
  const projected = readSubagentJournal(id);
  assert.equal(projected.status, 'failed');
  assert.equal(projected.result, null);
  assert.match(projected.error, /provider unavailable/);
});

test('subagent sidechains: hostile ids cannot escape the local state root', () => {
  assert.equal(subagentJournalFile('../../outside'), null);
  assert.equal(startSubagentJournal({ ...record('../../outside'), subagentId: '../../outside' }), false);
});
