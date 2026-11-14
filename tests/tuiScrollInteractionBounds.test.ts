import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleScrollbarMouse } from '../src/tui/scrollInteraction.js';

describe('scrollInteraction finite bounds', () => {
  it('handleScrollbarMouse ignores non-finite mouse coordinates and non-finite terminal dimensions', () => {
    const scrollToCalls: number[] = [];
    let toBottomCalls = 0;
    let drawCalls = 0;

    const viewport = {
      height: 20,
      maxScrollTop: () => 100,
      scrollTo: (row: number) => {
        scrollToCalls.push(row);
      },
      toBottom: () => {
        toBottomCalls++;
      },
      wheel: () => {}
    };

    const surface = {
      width: 80,
      stage: { height: 24, width: () => 80 },
      railEnabled: () => true,
      detached: false,
      activeTurnIndex: 2
    };

    const host = {
      out: { rows: 24 },
      notice: '',
      draw: () => {
        drawCalls++;
      }
    };

    // Column inside rail: mainW for 80 cols with sidebar check — test with wide width to avoid sidebar shrinking if any,
    // or test across rail column directly: for width 80 (mainW = 80), contentW = 77, rail columns are 76..80.
    const nanYResult = handleScrollbarMouse(
      { name: 'mouse', mouse: { x: 78, y: Number.NaN, pressed: true, button: 0 } },
      viewport,
      surface,
      host
    );

    assert.equal(nanYResult, false);
    assert.deepEqual(scrollToCalls, []);
    assert.equal(toBottomCalls, 0);
    assert.equal(drawCalls, 0);
    assert.equal(surface.activeTurnIndex, 2);

    // Non-finite host.out.rows should fall back cleanly and fractional coordinates should floor to integer cells.
    const infRowsHost = {
      out: { rows: Number.POSITIVE_INFINITY },
      notice: '',
      draw: () => {
        drawCalls++;
      }
    };

    const fracResult = handleScrollbarMouse(
      { name: 'mouse', mouse: { x: 80.9, y: 12.9, pressed: true, button: 0 } },
      viewport,
      surface,
      infRowsHost
    );

    assert.equal(fracResult, true);
    assert.equal(scrollToCalls.length, 1);
    assert.equal(Number.isFinite(scrollToCalls[0]), true);
    assert.equal(drawCalls, 1);
  });
});
