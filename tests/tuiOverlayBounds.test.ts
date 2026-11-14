import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Layer, drawPanel, panelRows } from '../src/tui/overlay.js';
import { visibleWidth } from '../src/tui/text.js';

describe('overlay bounds and sanitization', () => {
  it('Layer.rect clamps dimensions within narrow viewports and guards non-finite preferredHeight', () => {
    class BrokenLayer extends Layer {
      preferredHeight() { return Number.NaN; }
    }
    const layer = new BrokenLayer({ width: 80, height: 20 });
    const rect = layer.rect({ x: 0, y: 0, width: 14, height: 7 });
    assert.ok(rect.width <= 14, `rect.width ${rect.width} must fit within viewport width 14`);
    assert.ok(rect.height <= 7, `rect.height ${rect.height} must fit within viewport height 7`);
    assert.ok(rect.x >= 0 && rect.y >= 0);
  });

  it('panelRows collapses embedded newlines, handles null body(), and preserves exact frameWidth', () => {
    const rows = panelRows({
      title: 'Title\nInjected\x1b[2J',
      footer: 'Footer\r\nLine\x1b[2J',
      preferredHeight: () => 5,
      body: () => ['row1\nline2\x1b[2J', null as any]
    }, 36, 5);

    assert.equal(rows.length, 5);
    for (const row of rows) {
      assert.ok(!row.includes('\n') && !row.includes('\r'), 'panel row must not contain newlines');
      assert.ok(!row.includes('\x1b[2J'), 'panel row must strip unsafe CSI');
      assert.equal(visibleWidth(row), 36);
    }

    assert.doesNotThrow(() => {
      const empty = panelRows({
        title: 'Null body',
        preferredHeight: () => 4,
        body: () => null as any
      }, 24, 4);
      assert.equal(empty.length, 4);
    });
  });

  it('drawPanel strips newlines from title and footer before writing to screen', () => {
    const puts: Array<{ x: number; y: number; text: string }> = [];
    const mockScreen: any = {
      width: 40,
      height: 12,
      cells: [],
      fill() {},
      put(x: number, y: number, text: string) { puts.push({ x, y, text }); },
      setCursor() {}
    };
    drawPanel(mockScreen, { x: 2, y: 1, width: 30, height: 6 }, {
      title: 'Bad\nTitle',
      footer: 'Bad\r\nFooter'
    });
    for (const p of puts) {
      assert.ok(!p.text.includes('\n') && !p.text.includes('\r'), 'drawPanel output must be single-line');
    }
  });
});
