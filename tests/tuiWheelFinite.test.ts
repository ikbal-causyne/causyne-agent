import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Viewport } from '../src/tui/viewport.js';

test('invalid wheel notches cannot corrupt scroll accumulator or state', () => {
  const viewport = new Viewport({ transcript: { height: () => 100 }, height: 20 });
  viewport.scrollTo(25);
  for (const invalid of [NaN, Infinity, -Infinity, 1e308]) {
    assert.equal(viewport.wheel('down', invalid, 2000), 25);
    assert.ok(Number.isFinite(viewport.accumulator));
    assert.equal(viewport.lastWheelMoved, false);
  }
  assert.equal(viewport.wheel('down', 1, 3000), 28);
  assert.equal(viewport.scrollTop, 28);
});
