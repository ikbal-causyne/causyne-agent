import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { blockOf, contextMeter, panel } from '../src/tui/block.js';

describe('block contextMeter finite bounds', () => {
  it('handles non-finite token usage or context limits safely', () => {
    assert.equal(contextMeter(Number.POSITIVE_INFINITY, 1000), '');
    assert.equal(contextMeter(Number.NaN, 1000), '');
    assert.equal(contextMeter(500, Number.POSITIVE_INFINITY), '500');
    assert.equal(contextMeter(500, 1000), '500 (50%)');
  });

  it('panel and blockOf clamp non-finite widths without throwing RangeError', () => {
    assert.doesNotThrow(() => {
      const pNaN = panel(['hello'], { width: Number.NaN });
      assert.equal(pNaN.length, 3);
      const pInf = panel(['hello'], { width: Number.POSITIVE_INFINITY });
      assert.equal(pInf.length, 3);
      const bNaN = blockOf('hello', { width: Number.NaN });
      assert.equal(bNaN.length, 1);
    });
  });
});
