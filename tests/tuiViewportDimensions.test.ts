import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Viewport, DEFAULT_SCROLL_SPEED } from '../src/tui/viewport.js';

test('viewport dimensions never become NaN, Infinity or zero after resize', () => {
  const viewport = new Viewport({ height: NaN, width: Infinity, speed: NaN });
  assert.equal(viewport.height, 20);
  assert.equal(viewport.width, 80);
  assert.equal(viewport.speed, DEFAULT_SCROLL_SPEED);
  viewport.resize({ height: 0.3, width: 0.7 });
  assert.equal(viewport.height, 1);
  assert.equal(viewport.width, 1);
  viewport.resize({ height: Infinity, width: NaN });
  assert.equal(viewport.height, 1);
  assert.equal(viewport.width, 1);
});
