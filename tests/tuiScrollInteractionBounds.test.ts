import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleViewportWheel, handleScrollbarMouse, AdaptiveWheelDampener } from '../src/tui/scrollInteraction.js';

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

  it('AdaptiveWheelDampener guards non-finite constructor options without poisoning computeNotches or stepRows', () => {
    const dampener = new AdaptiveWheelDampener({
      minDamping: Number.NaN,
      thresholdMs: Number.NaN,
      minTickInterval: Number.NaN,
      burstWindowMs: Number.NaN,
      maxBurstNotches: Number.POSITIVE_INFINITY
    });

    assert.equal(dampener.computeNotches('down', 1000), 1.0);
    const second = dampener.computeNotches('down', 1020);
    assert.equal(Number.isFinite(second), true);
    assert.ok(second > 0 && second <= 1.0);

    const rows = dampener.stepRows('down', 3, 1040);
    assert.equal(Number.isFinite(rows), true);
    const followUp = dampener.stepRows('down', 3, 1060);
    assert.equal(Number.isFinite(followUp), true);
  });

  it('handleScrollbarMouse preserves activeTurnIndex on non-rail clicks, respects railEnabled=false, and honors surface.env sidebar disablement', () => {
    let scrolled = 0;
    const viewport: any = {
      height: 20,
      maxScrollTop: () => 50,
      scrollTo: () => { scrolled++; },
      toBottom: () => { scrolled++; }
    };
    const host: any = {
      out: { rows: 24 },
      notice: '',
      draw: () => {}
    };
    const surface: any = {
      width: 200,
      env: { CAUSYNE_SIDEBAR: 'off' },
      stage: { height: 24, width: () => 200 },
      railEnabled: () => true,
      activeTurnIndex: 4
    };

    // 1. Click in chat body (x = 10) must not wipe activeTurnIndex
    const bodyClick = handleScrollbarMouse(
      { name: 'mouse', mouse: { x: 10, y: 10, pressed: true, button: 0 } },
      viewport,
      surface,
      host
    );
    assert.equal(bodyClick, false);
    assert.equal(surface.activeTurnIndex, 4);

    // 2. Click at x = 156 with CAUSYNE_SIDEBAR=off on a 200-col screen is inside chat body, not the disabled sidebar rail
    const midClick = handleScrollbarMouse(
      { name: 'mouse', mouse: { x: 156, y: 10, pressed: true, button: 0 } },
      viewport,
      surface,
      host
    );
    assert.equal(midClick, false);
    assert.equal(surface.activeTurnIndex, 4);

    // 3. When railEnabled returns false, clicks at the right edge must not trigger scrollbar scrolling
    surface.railEnabled = () => false;
    const disabledRailClick = handleScrollbarMouse(
      { name: 'mouse', mouse: { x: 199, y: 10, pressed: true, button: 0 } },
      viewport,
      surface,
      host
    );
    assert.equal(disabledRailClick, false);
    assert.equal(scrolled, 0);

    // 4. When railEnabled returns true, clicking at x = 199 scrolls and clears activeTurnIndex
    surface.railEnabled = () => true;
    const validRailClick = handleScrollbarMouse(
      { name: 'mouse', mouse: { x: 199, y: 10, pressed: true, button: 0 } },
      viewport,
      surface,
      host
    );
    assert.equal(validRailClick, true);
    assert.equal(scrolled, 1);
    assert.equal(surface.activeTurnIndex, null);
  });

  it('guards undefined host.notice on detached recovery, empty pickerLayout, and non-finite maxScrollTop', () => {
    const scrollToCalls: number[] = [];
    let toBottomCalls = 0;
    const viewport: any = {
      height: 20,
      maxScrollTop: () => Number.NaN,
      wheel: () => 0,
      scrollTo: (n: number) => {
        scrollToCalls.push(n);
        return n;
      },
      toBottom: () => {
        toBottomCalls++;
        return 0;
      }
    };
    const surface: any = {
      width: 80,
      stage: { height: 24, width: () => 80 },
      detached: true,
      captureMouse: () => true,
      railEnabled: () => true
    };
    const host: any = {
      out: { rows: 24 },
      notice: undefined,
      pickerLayout: { pickerStart: 1, pickerCount: 0, totalPromptRows: 3 },
      draw: () => {}
    };

    assert.equal(
      handleViewportWheel({ name: 'wheel', wheel: { direction: 'up' } }, viewport, surface, host, 1000),
      true
    );
    const clicked = handleScrollbarMouse(
      { name: 'mouse', mouse: { x: 79, y: 10, pressed: true, button: 0 } },
      viewport,
      surface,
      host
    );
    assert.equal(clicked, true);
    assert.ok(scrollToCalls.every(Number.isFinite), `expected finite scrollTo targets, got ${scrollToCalls}`);
    assert.ok(scrollToCalls.length + toBottomCalls >= 1);
  });
});

