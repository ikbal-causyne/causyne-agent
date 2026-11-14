import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatByteSize } from '../src/tui/clipboardImage.js';

describe('clipboardImage bounds and path safety', () => {
  it('formatByteSize clamps negative and non-finite byte sizes to 0 B', () => {
    assert.equal(formatByteSize(-5), '0 B');
    assert.equal(formatByteSize(Number.NaN), '0 B');
    assert.equal(formatByteSize(Number.POSITIVE_INFINITY), '0 B');
  });
});
