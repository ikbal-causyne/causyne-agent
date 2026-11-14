import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { padEnd, truncate, wrapBlock } from '../src/tui/text.js';

describe('tui/text finite bounds', () => {
  it('truncate handles non-finite width without overflowing input', () => {
    assert.equal(truncate('hello world', Number.NaN), '');
    assert.equal(truncate('hello world', Number.NEGATIVE_INFINITY), '');
    assert.equal(truncate('hello world', Number.POSITIVE_INFINITY), 'hello world');
  });

  it('padEnd guards non-finite width and nullish input without throwing RangeError', () => {
    assert.doesNotThrow(() => {
      assert.equal(padEnd('hi', Number.POSITIVE_INFINITY), 'hi');
      assert.equal(padEnd(null, 4), '    ');
    });
  });

  it('wrapBlock clamps negative/non-finite hang and non-finite width', () => {
    assert.doesNotThrow(() => {
      const negHang = wrapBlock('alpha beta', 20, { hang: -1 });
      assert.deepEqual(negHang, ['alpha beta']);

      const infHang = wrapBlock('alpha beta', 20, { hang: Number.POSITIVE_INFINITY });
      assert.deepEqual(infHang, ['alpha beta']);

      const nanWidth = wrapBlock('alpha beta', Number.NaN);
      assert.deepEqual(nanWidth, ['alpha beta']);
    });
  });
});
