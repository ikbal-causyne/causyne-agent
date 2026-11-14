import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Layer, drawPanel, panelRows } from '../src/tui/overlay.js';
import { visibleWidth } from '../src/tui/text.js';

describe('overlay drawPanel finite bounds', () => {
  it('returns empty rect without throwing or looping on non-finite rect dimensions', () => {
    let writes = 0;
    const screen = {
      fill() { writes++; },
      put() { writes++; }
    };

    assert.doesNotThrow(() => {
      const infWidth = drawPanel(screen, { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 5 });
      assert.deepEqual(infWidth, { x: 0, y: 0, width: 0, height: 0 });

      const nanHeight = drawPanel(screen, { x: 1, y: 2, width: 10, height: Number.NaN });
      assert.deepEqual(nanHeight, { x: 1, y: 2, width: 0, height: 0 });

      const infHeight = drawPanel(screen, { x: 1, y: 2, width: 10, height: Number.POSITIVE_INFINITY });
      assert.deepEqual(infHeight, { x: 1, y: 2, width: 0, height: 0 });
    });

    assert.equal(writes, 0);
  });

  it('panelRows clamps non-finite and fractional dimensions without RangeError', () => {
    const layer = new Layer({ title: 'Title', footer: 'Footer', width: 40, height: 10 });
    layer.body = () => ['hello'];

    assert.doesNotThrow(() => {
      const infRows = panelRows(layer, Number.POSITIVE_INFINITY, 10);
      assert.ok(infRows.length >= 3);
      assert.ok(Number.isFinite(visibleWidth(infRows[0]!)));

      const nanRows = panelRows(layer, Number.NaN, Number.NaN);
      assert.equal(nanRows.length, 3);
      assert.equal(visibleWidth(nanRows[0]!), 8);

      const fracRows = panelRows(layer, 20.9, 6.9);
      assert.equal(visibleWidth(fracRows[0]!), 20);
      assert.equal(visibleWidth(fracRows[1]!), 20);
    });
  });

  it('Layer.rect sanitizes non-finite and fractional viewport coordinates', () => {
    const layer = new Layer({ title: 'T', width: 40, height: 10 });
    const badRect = layer.rect({
      x: Number.NaN,
      y: Number.NaN,
      width: Number.POSITIVE_INFINITY,
      height: Number.NaN
    });
    assert.ok(Number.isFinite(badRect.x));
    assert.ok(Number.isFinite(badRect.y));
    assert.ok(Number.isFinite(badRect.width));
    assert.ok(Number.isFinite(badRect.height));

    const fracRect = layer.rect({ x: 1.8, y: 2.9, width: 80.7, height: 24.4 });
    assert.equal(Number.isInteger(fracRect.width), true);
    assert.equal(Number.isInteger(fracRect.height), true);
  });
});
