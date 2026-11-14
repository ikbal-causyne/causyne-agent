import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { contextMeter } from '../src/tui/block.js';

describe('block contextMeter finite bounds', () => {
  it('handles non-finite token usage or context limits safely', () => {
    assert.equal(contextMeter(Number.POSITIVE_INFINITY, 1000), '');
    assert.equal(contextMeter(Number.NaN, 1000), '');
    assert.equal(contextMeter(500, Number.POSITIVE_INFINITY), '500');
    assert.equal(contextMeter(500, 1000), '500 (50%)');
  });
});
