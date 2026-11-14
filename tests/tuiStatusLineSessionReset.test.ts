import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StatusLine } from '../src/tui/statusLine.js';

test('new workspace with zero measured context clears stale prior-session context', () => {
  const status = new StatusLine().setSession({ contextChars: 4000, contextLimit: 16000 });
  assert.equal(status.contextChars, 4000);
  status.setSession({ contextChars: 0, contextLimit: 0, cwd: '/tmp/new-workspace' });
  assert.equal(status.contextChars, 0);
  assert.equal(status.contextLimit, 0);
  assert.doesNotMatch(status.renderIdle({ width: 100 }), /25%/);
});

test('an omitted or invalid measurement does not overwrite the last valid one', () => {
  const status = new StatusLine().setSession({ contextChars: 1200, contextLimit: 8000 });
  status.onUsage({ contextChars: Number.NaN, contextLimitChars: Number.POSITIVE_INFINITY });
  status.setSession({});
  assert.equal(status.contextChars, 1200);
  assert.equal(status.contextLimit, 8000);
});
