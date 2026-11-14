import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Stage } from '../src/tui/stage.js';

describe('Stage finite bounds', () => {
  it('Stage constructor, reserve, and resize handle non-finite height and rows without RangeError', () => {
    const out = { columns: 80, rows: 24, isTTY: true, write: () => true };

    assert.doesNotThrow(() => {
      const stageInf = new Stage({ out, height: Number.POSITIVE_INFINITY });
      assert.equal(Number.isFinite(stageInf.maxHeight), true);
      stageInf.reserve(Number.NaN);
      assert.equal(Number.isFinite(stageInf.height), true);
      assert.ok(stageInf.height >= 1);

      stageInf.resize(Number.POSITIVE_INFINITY);
      assert.equal(Number.isFinite(stageInf.maxHeight), true);
      assert.equal(Number.isFinite(stageInf.height), true);
    });
  });
});
