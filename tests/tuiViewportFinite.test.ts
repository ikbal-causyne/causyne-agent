import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Viewport } from '../src/tui/viewport.js';

test('non-finite absolute and relative scroll positions cannot poison viewport state', () => {
  const viewport = new Viewport({ transcript: { height: () => 200 }, height: 20, width: 80 });
  viewport.scrollTo(25);
  for (const invalid of [NaN, Infinity, -Infinity]) {
    assert.equal(viewport.scrollTo(invalid), 25);
    assert.equal(viewport.scrollBy(invalid), 25);
  }
  assert.equal(viewport.scrollTop, 25);
  assert.ok(Number.isFinite(viewport.state().progress));
  assert.equal(viewport.scrollTo(180), 180);
});
