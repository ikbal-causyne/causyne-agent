import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { alignTranscriptRows, sessionStageHeight } from '../src/tui/sessionLayout.js';

describe('sessionLayout finite bounds', () => {
  it('sessionStageHeight returns a finite positive integer when inputs are non-finite or negative', () => {
    const hNaN = sessionStageHeight(Number.NaN, Number.NaN, Number.NaN, false);
    assert.equal(Number.isFinite(hNaN), true);
    assert.equal(hNaN, 1);

    const hInf = sessionStageHeight(24, 3, Number.POSITIVE_INFINITY, false);
    assert.equal(Number.isFinite(hInf), true);
    assert.equal(hInf, 24);

    const hNeg = sessionStageHeight(20, -4, -2, false);
    assert.equal(hNeg, 1);
  });

  it('alignTranscriptRows never throws RangeError on non-finite contentRows', () => {
    assert.doesNotThrow(() => {
      const aligned = alignTranscriptRows(['a', 'b'], Number.NaN);
      assert.equal(aligned.length, 2);
      assert.deepEqual(aligned, ['', '']);
    });

    assert.deepEqual(alignTranscriptRows(['a', 'b'], Number.POSITIVE_INFINITY), ['a', 'b']);
  });
});
