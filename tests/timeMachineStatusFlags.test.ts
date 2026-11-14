import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TimeMachine } from '../src/timeMachine.js';

test('TimeMachine recognizes explicit tool ok=false and MCP isError=true without a string error', () => {
  for (const marker of [{ ok: false }, { isError: true }]) {
    const machine = new TimeMachine();
    const args = { command: 'npm test' };
    assert.equal(machine.observe('exec', args, marker).attempt, 1);
    assert.equal(machine.observe('exec', args, marker).attempt, 2);
    const gate = machine.observe('exec', args, marker);
    assert.equal(gate.kind, 'consent');
    assert.equal(gate.attempt, 3);
    assert.equal(machine.observe('exec', args, { success: true, exitCode: 0 }).kind, 'resolved');
  }
});
