import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SidechainEventLog } from '../src/session/sidechainEvents.js';

describe('SidechainEventLog', () => {
  it('records tool calls and observations', () => {
    const log = new SidechainEventLog();
    log.append({
      id: 'evt_1',
      timestamp: Date.now(),
      kind: 'ToolCall',
      source: 'agent',
      tool: 'fs_write',
      callId: 'call_1',
      arguments: { path: 'test.txt' }
    });
    log.append({
      id: 'evt_2',
      timestamp: Date.now(),
      kind: 'ToolObservation',
      source: 'environment',
      tool: 'fs_write',
      callId: 'call_1',
      success: true,
      outputLength: 24
    });

    assert.equal(log.getEvents().length, 2);
  });

  it('records condensation events and tracks forgotten event ids', () => {
    const log = new SidechainEventLog();
    log.append({ id: 'evt_1', timestamp: 1, kind: 'ToolCall', source: 'agent', tool: 'ls', callId: 'c1', arguments: {} });
    log.append({ id: 'evt_2', timestamp: 2, kind: 'ToolCall', source: 'agent', tool: 'cat', callId: 'c2', arguments: {} });

    const cond = log.recordCondensation(['evt_1', 'evt_2'], 'Early file probes compacted', 5000, 200, 50000);
    assert.equal(cond.kind, 'Condensation');
    assert.equal(cond.forgotten_event_ids.length, 2);

    const forgotten = log.getForgottenIds();
    assert.ok(forgotten.has('evt_1'));
    assert.ok(forgotten.has('evt_2'));
    assert.ok(!forgotten.has('unknown_evt'));
  });

  it('serializes to valid JSONL', () => {
    const log = new SidechainEventLog();
    log.recordCondensation(['a', 'b'], 'Summary', 100, 10, 1000);
    const jsonl = log.serializeJsonl();
    const parsed = JSON.parse(jsonl.trim());
    assert.equal(parsed.kind, 'Condensation');
    assert.equal(parsed.summary, 'Summary');
  });
});
