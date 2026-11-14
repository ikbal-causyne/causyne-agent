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

  it('Stage.grow and Stage.moveTo ignore non-finite deltas and floor fractional moveTo rows', () => {
    const out = { columns: 80, rows: 30, isTTY: true, write: () => true };
    const stage = new Stage({ out, height: 20 });
    stage.reserve(5);

    assert.equal(stage.grow(Number.NaN), 0);
    assert.equal(stage.height, 5);
    assert.equal(Number.isFinite(stage.cursor), true);

    stage.moveTo(Number.NaN);
    assert.equal(Number.isFinite(stage.cursor), true);

    stage.moveTo(2.9);
    assert.equal(stage.cursor, 2);
  });
});
