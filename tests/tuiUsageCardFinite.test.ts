import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderProgressBar } from '../src/tui/usageCard.js';
import { visibleWidth } from '../src/tui/text.js';

describe('usageCard renderProgressBar finite bounds', () => {
  it('handles non-finite percent or barLength without throwing or collapsing to empty', () => {
    const barNaN = renderProgressBar(Number.NaN, 20);
    assert.equal(visibleWidth(barNaN), 20);

    assert.doesNotThrow(() => {
      const barInf = renderProgressBar(50, Number.POSITIVE_INFINITY);
      assert.equal(visibleWidth(barInf), 24);
    });
  });
});
