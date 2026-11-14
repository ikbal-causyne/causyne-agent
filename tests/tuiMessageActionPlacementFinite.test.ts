import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { placeMessageActionPanel } from '../src/tui/messageActionPlacement.js';

describe('placeMessageActionPanel finite bounds', () => {
  const viewport = Array.from({ length: 16 }, (_v, i) => `row ${i}`);
  const panel = ['+----+', '| ok |', '+----+'];

  it('rejects non-finite contentWidth and keeps layout coordinates finite on non-finite anchors', () => {
    assert.equal(placeMessageActionPanel(viewport, panel, Number.NaN, 0, 5, 1).layout, null);
    assert.equal(placeMessageActionPanel(viewport, panel, Number.POSITIVE_INFINITY, 0, 5, 1).layout, null);

    const withNaNAnchor = placeMessageActionPanel(viewport, panel, 60, Number.NaN, Number.NaN, 1);
    assert.ok(withNaNAnchor.layout);
    assert.equal(Number.isFinite(withNaNAnchor.layout.x), true);
    assert.equal(Number.isFinite(withNaNAnchor.layout.y), true);

    const withNaNBounds = placeMessageActionPanel(viewport, panel, 60, 0, null, 1, {
      messageBounds: { startRow: Number.NaN, endRow: Number.NaN }
    });
    assert.ok(withNaNBounds.layout);
    assert.equal(Number.isFinite(withNaNBounds.layout.y), true);
    assert.ok(withNaNBounds.rows.some(row => row.includes('| ok |')));
  });
});
