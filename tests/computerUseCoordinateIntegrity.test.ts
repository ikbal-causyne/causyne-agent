import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCoordinateNumbers, groundPoint, groundBoxCenter, parseSingleAction } from '../src/computerUse/visionGrounding.js';

const display = { width: 1920, height: 1080, scaleFactor: 1 };

test('corrupt numeric tokens are rejected instead of shifting click coordinates', () => {
  assert.deepEqual(extractCoordinateNumbers('(100, invalid, 300)'), []);
  assert.deepEqual(extractCoordinateNumbers('(100x, 200)'), []);
  assert.deepEqual(extractCoordinateNumbers('(100, 200)'), [100, 200]);
  assert.equal(parseSingleAction("click(start_box='(100, invalid, 300)')", display)?.coordinates, undefined);
});

test('invalid screen dimensions and partial boxes do not produce actionable coordinates', () => {
  assert.equal(groundPoint([NaN, 500], display), null);
  assert.equal(groundPoint([500, 500], { width: NaN, height: 1080 }), null);
  assert.equal(groundPoint([500, 500], { width: 1920, height: 1080, scaleFactor: Infinity, targetSpace: 'physical' }), null);
  assert.equal(groundBoxCenter([100, 200, 300], display), null);
  assert.equal(groundBoxCenter([100, 200, Infinity, 400], display), null);
  assert.deepEqual(groundPoint([500, 500], display), { x: 960, y: 540 });
});
