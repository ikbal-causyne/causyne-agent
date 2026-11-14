import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TimeMachine } from '../src/timeMachine.js';

test('missing or malformed tool args do not crash the recovery supervisor', () => {
  for (const args of [null, undefined, [], 'malformed arguments']) {
    const machine = new TimeMachine();
    const failure = { success: false, error: 'invalid arguments' };
    const first = machine.observe('exec', args as any, failure);
    assert.equal(first.attempt, 1);
    const second = machine.observe('exec', args as any, failure);
    assert.equal(second.attempt, 2);
    assert.equal(machine.observe('exec', args as any, { success: true }).kind, 'resolved');
  }
});
