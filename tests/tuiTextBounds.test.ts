import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { truncate } from '../src/tui/text.js';

describe('tui/text finite bounds', () => {
  it('truncate handles non-finite width without overflowing input', () => {
    assert.equal(truncate('hello world', Number.NaN), '');
    assert.equal(truncate('hello world', Number.NEGATIVE_INFINITY), '');
    assert.equal(truncate('hello world', Number.POSITIVE_INFINITY), 'hello world');
  });
});
