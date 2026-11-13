import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Viewport } from '../src/tui/viewport.js';

test('malformed transcript height cannot corrupt scrollbar or scroll positions', () => {
  for (const height of [NaN, Infinity, -Infinity, -10]) {
    const viewport = new Viewport({ transcript: { height: () => height } });
    assert.equal(viewport.contentHeight(), 0);
    assert.equal(viewport.maxScrollTop(), 0);
    assert.equal(viewport.toBottom(), 0);
    assert.equal(viewport.state().progress, null);
  }
});
