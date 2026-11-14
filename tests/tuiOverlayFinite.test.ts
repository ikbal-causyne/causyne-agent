import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { drawPanel } from '../src/tui/overlay.js';

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
});
