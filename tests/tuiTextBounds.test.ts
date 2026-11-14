import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { expandTabs, padEnd, stripAnsi, truncate, visibleWidth, wrap, wrapBlock } from '../src/tui/text.js';

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

  it('expandTabs falls back to TAB_WIDTH when tabWidth is < 1 or non-finite', () => {
    assert.doesNotThrow(() => {
      assert.equal(expandTabs('a\tb', 0), 'a       b');
      assert.equal(expandTabs('a\tb', -4), 'a       b');
      assert.equal(expandTabs('a\tb', Number.NaN), 'a       b');
      assert.equal(expandTabs('a\tb', Number.POSITIVE_INFINITY), 'a       b');
    });
  });

  it('wrap handles nullish input and NaN or sub-1 widths without corrupting text', () => {
    assert.deepEqual(wrap(null, 0), ['']);
    assert.deepEqual(wrap('alpha beta', Number.NaN), ['alpha beta']);
    assert.deepEqual(wrap('alpha beta', 0.5), ['alpha beta']);
    assert.deepEqual(wrap('a\nb', Number.POSITIVE_INFINITY), ['a', 'b']);
  });

  it('wrap preserves ANSI escape sequences and wide characters across hard word breaks', () => {
    const ansiWrapped = wrap('\x1b[31mabcdef\x1b[0m', 3);
    assert.equal(ansiWrapped.map(stripAnsi).join(''), 'abcdef');
    for (const row of ansiWrapped) {
      assert.ok(visibleWidth(row) <= 3);
    }

    const cjkWrapped = wrap('a中b', 2);
    assert.deepEqual(cjkWrapped, ['a', '中', 'b']);
  });

  it('expandTabs aligns tab stops using visible column widths and ignores ANSI escapes', () => {
    const cjkExpanded = expandTabs('中\tb', 8);
    assert.equal(cjkExpanded, '中      b');
    assert.equal(visibleWidth(cjkExpanded), 9);

    const ansiExpanded = expandTabs('\x1b[31mab\x1b[0m\tc', 8);
    assert.equal(stripAnsi(ansiExpanded), 'ab      c');
    assert.equal(visibleWidth(ansiExpanded), 9);
  });
});
