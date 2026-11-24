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
