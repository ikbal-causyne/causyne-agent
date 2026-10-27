import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groundPoint, groundBoxCenter } from '../src/computerUse/visionGrounding.js';

test('BUG-01 baseline: groundPoint must return OS logical points, not double-scaled physical pixels', () => {
  // macOS Retina display: Logical points 2560x1440, backing scale factor 2x (Physical 5120x2880)
  const retinaContext = {
    width: 2560,
    height: 1440,
    scaleFactor: 2
  };

  // Center coordinate in normalized 0-1000 space
  const normalizedMidpoint = [500, 500];

  const grounded = groundPoint(normalizedMidpoint, retinaContext);
  assert.ok(grounded !== null, 'groundPoint must return non-null for valid coordinates');

  // The true target in OS logical space is exactly (1280, 720)
  // BUG-01 in v1 computes: 0.5 * 2560 * 2 = 2560 (landing on outer edge or off-screen)
  assert.equal(
    grounded.x,
    1280,
    `X coordinate was ${grounded.x}, expected logical point 1280. Double-scaling bug detected!`
  );
  assert.equal(
    grounded.y,
    720,
    `Y coordinate was ${grounded.y}, expected logical point 720. Double-scaling bug detected!`
  );
});

test('BUG-01 baseline: groundBoxCenter must return OS logical points for bounding box', () => {
  const retinaContext = {
    width: 2560,
    height: 1440,
    scaleFactor: 2
  };

  // Box from (100, 100) to (300, 300) in 0-1000 space -> center is (200, 200) -> 20% of screen
  const box = [100, 100, 300, 300];
  const grounded = groundBoxCenter(box, retinaContext);
  assert.ok(grounded !== null);

  // 0.2 * 2560 = 512, 0.2 * 1440 = 288
  assert.equal(grounded.x, 512, `X coordinate was ${grounded.x}, expected 512`);
  assert.equal(grounded.y, 288, `Y coordinate was ${grounded.y}, expected 288`);
});
