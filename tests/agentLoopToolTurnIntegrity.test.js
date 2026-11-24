import test from 'node:test';
import assert from 'node:assert/strict';
import { repairUnansweredToolCalls, validateToolCallBatch } from '../src/agent/toolTurnIntegrity.js';

const call = (id, name = 'fs_read') => ({ id, function: { name, arguments: '{}' } });
const assistant = (...tool_calls) => ({ role: 'assistant', tool_calls });
const reply = id => ({ role: 'tool', tool_call_id: id, content: 'original' });

test('tool batches reject blank and NUL IDs', () => {
  for (const id of ['', '  ', 'bad\x00id']) assert.equal(validateToolCallBatch([call(id)]).valid, false);
  assert.equal(validateToolCallBatch([call('valid-id')]).valid, true);
});

test('tool batches reject blank or NUL function names', () => {
  for (const name of ['', '   ', 'bad\x00tool']) assert.equal(validateToolCallBatch([call('id', name)]).valid, false);
});

test('tool batch limits cannot be bypassed using NaN or Infinity', () => {
  for (const limit of [NaN, Infinity, 0, -1, 1.5]) assert.equal(validateToolCallBatch([call('id')], limit).valid, false);
});

test('duplicate historical replies are reported as ambiguous without modifying them', () => {
  const history = [assistant(call('id')), reply('id'), reply('id')];
  const before = structuredClone(history);
  const report = repairUnansweredToolCalls(history);
  assert.equal(report.unresolved, 1);
  assert.equal(report.repaired, 0);
  assert.deepEqual(history, before);
});

test('malformed historical calls cannot disappear silently during recovery', () => {
  const history = [assistant(null, 'invalid', call('ok')), reply('ok')];
  const report = repairUnansweredToolCalls(history);
  assert.equal(report.unresolved, 2);
  assert.equal(report.repaired, 0);
});

test('foreign result IDs are reported rather than accepted as current turn evidence', () => {
  const history = [assistant(call('ok')), reply('ok'), reply('foreign')];
  const report = repairUnansweredToolCalls(history);
  assert.equal(report.unresolved, 1);
  assert.equal(report.repaired, 0);
});

test('duplicate assistant call IDs remain unresolved and are never given invented replies', () => {
  const history = [assistant(call('duplicate'), call('duplicate'))];
  const before = structuredClone(history);
  const report = repairUnansweredToolCalls(history);
  assert.equal(report.unresolved, 1);
  assert.equal(report.repaired, 0);
  assert.deepEqual(history, before);
});
