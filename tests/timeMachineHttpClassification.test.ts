import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TimeMachine } from '../src/timeMachine.js';

test('HTTP 429 without an error string still demands backoff rather than immediate retries', () => {
  const machine = new TimeMachine();
  const outcome = machine.observe('web_fetch', { url: 'https://example.org/rate' }, { status: 429 });
  assert.equal(outcome.failureClass, 'rate_limited');
  assert.equal(outcome.kind, 'replan');
  assert.match(outcome.guidance, /retry\/reset window/);
});

test('HTTP 401 without a message requires authentication instead of blindly retrying', () => {
  const machine = new TimeMachine();
  const outcome = machine.observe('github_api', { endpoint: 'https://api.github.com' }, { status: 401 });
  assert.equal(outcome.failureClass, 'permission');
  assert.equal(outcome.kind, 'human');
});
