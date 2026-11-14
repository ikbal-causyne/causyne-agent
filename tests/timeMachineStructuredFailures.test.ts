import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TimeMachine } from '../src/timeMachine.js';

test('structured tool errors do not silently reset the Time Machine failure budget', () => {
  for (const result of [
    { status: 'error' }, { status: 'failed' }, { status: 500 },
    { error: { message: 'network failure' } }
  ]) {
    const machine = new TimeMachine();
    const args = { command: 'npm test' };
    assert.equal(machine.observe('exec', args, { success: false, error: 'test failed' }).attempt, 1);
    const decision = machine.observe('exec', args, result);
    assert.equal(decision.attempt, 2, JSON.stringify(result));
    assert.notEqual(decision.kind, 'resolved', JSON.stringify(result));
  }
});

test('successful HTTP status and empty error do not count as failures', () => {
  const machine = new TimeMachine();
  assert.equal(machine.observe('web_fetch', { url: 'https://example.org' }, { status: 200, error: '' }).kind, 'none');
});
