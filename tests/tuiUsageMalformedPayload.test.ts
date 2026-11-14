import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StatusLine } from '../src/tui/statusLine.js';

test('status line ignores malformed usage payloads without throwing or losing known counters', () => {
  const status = new StatusLine();
  status.onUsage({ taskTokens: 30, taskCostUsd: 0.05, cachedTokens: 2 });
  for (const malformed of [null, false, 7, 'garbage']) {
    assert.doesNotThrow(() => status.onUsage(malformed as any));
    assert.equal(status.turnTokens, 30);
    assert.equal(status.turnCost, 0.05);
  }
  assert.equal(status.onUsage({ taskTokens: 40 }).turnTokens, 40);
});
