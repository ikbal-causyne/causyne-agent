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

  it('guards maxVisibleLines and non-finite startLine in renderThinkingFrame', () => {
    const content = Array.from({ length: 12 }, (_, i) => `thought line ${i + 1}`).join('\n');

    const zeroStreaming = renderThinkingFrame(content, {
      streaming: true,
      maxVisibleLines: 0
    }).join('\n');
    assert.doesNotMatch(zeroStreaming, /13 earlier/);

    const nanStartCompleted = renderThinkingFrame(content, {
      streaming: false,
      maxVisibleLines: 4,
      startLine: Number.NaN
    });
    assert.ok(nanStartCompleted.length >= 6);
    assert.match(nanStartCompleted.join('\n'), /thought line 1\b/);
  });

  it('falls back to default activity label when activity or title trims to empty', () => {
    const content = Array.from({ length: 12 }, (_, i) => `thought line ${i + 1}`).join('\n');
    const streamingBlank = renderThinkingFrame(content, {
      streaming: true,
      maxVisibleLines: 4,
      title: '...',
      activity: '   '
    }).join('\n');
    assert.match(streamingBlank, /earlier thinking lines scrolled/);
    assert.doesNotMatch(streamingBlank, /earlier\s{2,}lines/);

    const collapsedBlank = renderThinkingFrame(content, {
      streaming: false,
      collapsed: true,
      title: '...'
    }).join('\n');
    assert.match(collapsedBlank, /Thought/);

    const expandedBlank = renderThinkingFrame(content, {
      streaming: false,
      title: '   ',
      activity: '...'
    }).join('\n');
    assert.match(expandedBlank, /thinking/);
  });
});
