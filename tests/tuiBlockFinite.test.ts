import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { barBlock, blockOf, contextMeter, panel } from '../src/tui/block.js';

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

  it('contextMeter prevents rounding rollover and barBlock/panel collapse embedded newlines', () => {
    assert.equal(contextMeter(999.6, 0), '1.0K');
    assert.equal(contextMeter(999600, 0), '1.0M');

    const blockRows = barBlock(['first\nsecond', null as any], { width: 40 });
    assert.equal(blockRows.length, 2);
    for (const row of blockRows) {
      assert.ok(!row.includes('\n') && !row.includes('\r'), 'barBlock row must not contain embedded newlines');
    }

    const panelRows = panel(['line1\r\nline2'], { width: 40, title: 'bad\ntitle' });
    assert.equal(panelRows.length, 3);
    for (const row of panelRows) {
      assert.ok(!row.includes('\n') && !row.includes('\r'), 'panel row must not contain embedded newlines');
    }
  });

  it('guards nullish options, prevents 10.0K rounding seam, truncates long panel titles, and resets open SGR', () => {
    assert.doesNotThrow(() => {
      barBlock(['a'], null as any);
      blockOf('a', null as any);
      panel(['a'], null as any);
    });
    assert.equal(contextMeter(9960, 0), '10K');
    const narrowed = panel(['\x1b[31munclosed red row'], { width: 20, title: 'VeryLongTitleTruncated' });
    assert.ok(narrowed[0]!.includes('VeryLong'), 'panel should truncate long title rather than drop it');
    assert.ok(narrowed[1]!.includes('\x1b[0m'), 'panel row should reset open SGR before right border');
  });
});
