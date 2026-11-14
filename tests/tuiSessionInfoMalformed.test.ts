import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StatusLine } from '../src/tui/statusLine.js';

test('malformed session metadata cannot crash status rendering or overwrite active context', () => {
  const line = new StatusLine().setSession({ model: 'gpt-test', cwd: '/tmp/work', contextChars: 300 });
  for (const payload of [null, false, 123, 'wrong']) {
    assert.doesNotThrow(() => line.setSession(payload as any));
    assert.equal(line.cwd, '/tmp/work');
    assert.equal(line.contextChars, 300);
  }
});
