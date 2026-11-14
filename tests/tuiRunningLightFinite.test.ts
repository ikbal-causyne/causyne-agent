import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runningLightWindow } from '../src/tui/runningLight.js';

describe('runningLightWindow finite bounds', () => {
  it('returns inactive window for non-finite runesLen', () => {
    assert.deepEqual(runningLightWindow(Number.NaN, 100), { start: 0, width: 0, active: false });
    assert.deepEqual(runningLightWindow(Number.POSITIVE_INFINITY, 100), { start: 0, width: 0, active: false });
  });
});
