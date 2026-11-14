import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TimeMachine } from '../src/timeMachine.js';

test('approval and authentication requirements stop retrying even when no error string is supplied', () => {
  for (const flag of ['requiresConsent', 'requiresApproval', 'authenticationRequired']) {
    const machine = new TimeMachine();
    const result = { [flag]: true };
    const decision = machine.observe('desktop_act', { app: 'Notes' }, result);
    assert.equal(decision.kind, 'human', flag);
    assert.equal(decision.attempt, 1, flag);
    assert.match(decision.guidance, /Permission or authentication/i);
    assert.notEqual(machine.observe('desktop_act', { app: 'Notes' }, result).kind, 'resolved');
  }
});

test('site refusal does not become a local approval request even if remote message says permission required', () => {
  const machine = new TimeMachine();
  const outcome = machine.observe('web_fetch', { url: 'https://example.org/unavailable' }, {
    failureKind: 'site_refusal', status: 403, error: 'approval required'
  });
  assert.equal(outcome.kind, 'replan');
});
