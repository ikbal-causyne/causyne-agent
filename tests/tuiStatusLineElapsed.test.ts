import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatElapsed } from '../src/tui/statusLine.js';

describe('formatElapsed', () => {
  it('clamps negative and non-finite durations to zero seconds', () => {
    assert.equal(formatElapsed(-500), '0.0s');
    assert.equal(formatElapsed(-1), '0.0s');
    assert.equal(formatElapsed(Number.NaN), '0.0s');
    assert.equal(formatElapsed(Number.POSITIVE_INFINITY), '0.0s');
    assert.equal(formatElapsed(1500), '1.5s');
  });
});
