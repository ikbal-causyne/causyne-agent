import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildThinkingBoxBorders,
  calculateThinkingLineCount,
  renderThinkingFrame
} from '../src/tui/thinkingBox.js';
import { visibleWidth } from '../src/tui/text.js';

describe('thinkingBox finite bounds', () => {
  it('clamps non-finite width across calculateThinkingLineCount, buildThinkingBoxBorders, and renderThinkingFrame', () => {
    const lineCountNaN = calculateThinkingLineCount('hello world', Number.NaN);
    const lineCountDefault = calculateThinkingLineCount('hello world', 80);
    assert.equal(lineCountNaN, lineCountDefault);

    assert.doesNotThrow(() => {
      const borders = buildThinkingBoxBorders('Thought', 'esc', Number.POSITIVE_INFINITY);
      assert.equal(visibleWidth(borders.top), 80);
      assert.equal(visibleWidth(borders.bottom), 80);

      const frameInf = renderThinkingFrame('hello', { width: Number.POSITIVE_INFINITY });
      assert.ok(frameInf.length > 0);
      assert.equal(visibleWidth(frameInf[0]!), 80);

      const frameNaN = renderThinkingFrame('hello', { width: Number.NaN });
      assert.ok(frameNaN.length > 0);
      assert.equal(visibleWidth(frameNaN[0]!), 80);
    });
  });
});
