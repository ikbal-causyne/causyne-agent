import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Viewport, ScrollAcceleration } from '../src/tui/viewport.js';

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

test('ScrollAcceleration falls back cleanly when streakTimeout or minTickInterval is non-finite', () => {
  const accel = new ScrollAcceleration({
    streakTimeout: Number.NaN,
    minTickInterval: Number.NaN
  });

  assert.equal(accel.tick(1000), 1);
  assert.equal(accel.tick(1020) > 1, true);
  assert.equal(accel.tick(1020), 1);
  assert.equal(accel.tick(1520), 1);
});

test('Viewport.refresh ignores non-finite grownBy without setting unseen to Infinity', () => {
  const viewport = new Viewport({ transcript: { height: () => 200 }, height: 20, width: 80 });
  viewport.scrollTo(10);
  assert.equal(viewport.manual, true);

  viewport.refresh(Number.POSITIVE_INFINITY);
  assert.equal(viewport.unseen, 0);
  assert.equal(viewport.manual, true);

  viewport.refresh(Number.NaN);
  assert.equal(viewport.unseen, 0);

  viewport.refresh(3);
  assert.equal(viewport.unseen, 3);
});
