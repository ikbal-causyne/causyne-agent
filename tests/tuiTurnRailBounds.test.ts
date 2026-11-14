import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTurnRailCells,
  formatTurnTimestamp,
  handleTurnRailMouse,
  overlayTurnPreviewCard,
  renderTurnPreviewCard,
  resolveActiveTurnIndex,
  sliceFromColumn,
  type SessionTurn
} from '../src/tui/turnRail.js';
import { visibleWidth } from '../src/tui/text.js';

const sampleTurn = (turnIndex: number, startRow: number): SessionTurn => ({
  turnIndex,
  totalTurns: 3,
  userPrompt: `Turn ${turnIndex}`,
  assistantSummary: '',
  timestamp: 0,
  formattedDate: '',
  frameId: turnIndex,
  startRow
});

describe('turnRail finite bounds', () => {
  it('resolveActiveTurnIndex handles non-finite scrollTop and viewportHeight', () => {
    const turns = [sampleTurn(1, 0), sampleTurn(2, 20), sampleTurn(3, 50)];
    assert.equal(resolveActiveTurnIndex(turns, Number.NaN, 20, false), 1);
    assert.equal(resolveActiveTurnIndex(turns, 10, Number.POSITIVE_INFINITY, false), 1);
  });

  it('sliceFromColumn treats NaN startCol as 0 and Infinity as empty slice', () => {
    assert.equal(sliceFromColumn('hello world', Number.NaN), 'hello world');
    assert.equal(sliceFromColumn('hello world', Number.POSITIVE_INFINITY), '');
  });

  it('buildTurnRailCells handles fractional and non-finite height without RangeError', () => {
    const turns = [sampleTurn(1, 0), sampleTurn(2, 20)];
    assert.doesNotThrow(() => {
      assert.deepEqual(buildTurnRailCells(turns, Number.NaN, 1, null).cells, []);
      assert.deepEqual(buildTurnRailCells(turns, Number.POSITIVE_INFINITY, 1, null).cells, []);
      assert.equal(buildTurnRailCells(turns, 5.7, 1, null).cells.length, 5);
    });
  });

  it('renderTurnPreviewCard falls back safely on non-finite maxCardWidth', () => {
    const rows = renderTurnPreviewCard(sampleTurn(1, 0), Number.NaN);
    assert.equal(visibleWidth(rows[0]!), 50);
  });

  it('overlayTurnPreviewCard handles non-finite and fractional coordinates without corruption or RangeError', () => {
    const viewport = Array.from({ length: 12 }, (_, i) => `row-${i}`.padEnd(80, ' '));
    const card = renderTurnPreviewCard(sampleTurn(1, 0), 40);
    assert.doesNotThrow(() => {
      const infScreen = overlayTurnPreviewCard(viewport, card, 4, 1, Number.POSITIVE_INFINITY);
      assert.deepEqual(infScreen, viewport);
    });
    const nanAnchor = overlayTurnPreviewCard(viewport, card, Number.NaN, 1, 80);
    assert.equal(Object.prototype.hasOwnProperty.call(nanAnchor, 'NaN'), false);
    const fractional = overlayTurnPreviewCard(viewport, card, 6.8, 1.4, 80);
    assert.equal(Object.keys(fractional).length, viewport.length);
    assert.ok(fractional.some((row) => row.includes('Turn 1')));
  });

  it('handleTurnRailMouse floors fractional pointer coordinates and ignores non-finite ones', () => {
    const turns = [sampleTurn(1, 0), sampleTurn(2, 42)];
    let scrolledTo: number | null = null;
    const surface: any = {
      activeTurnIndex: 2,
      hoveredTurnIndex: null,
      hoveredTurnAnchorY: null,
      turnRailLayout: {
        railX: 1,
        stageTop: 3,
        viewportHeight: 10,
        rowToTurn: new Map([[4, 1]]),
        dotRows: new Map(),
        turns
      },
      viewport: {
        scrollTo(row: number) { scrolledTo = row; },
        toBottom() {}
      }
    };
    const host = { draw() {}, scheduleDraw() {} };

    const badHandled = handleTurnRailMouse({ mouse: { x: Number.NaN, y: 7, button: 0, pressed: true } }, surface, host);
    assert.equal(badHandled, false);

    const fracHandled = handleTurnRailMouse({ mouse: { x: 1.8, y: 7.9, button: 0, pressed: true } }, surface, host);
    if (surface._turnRailSuppressTimer) clearTimeout(surface._turnRailSuppressTimer);
    assert.equal(fracHandled, true);
    assert.equal(scrolledTo, 0);
  });

  it('formatTurnTimestamp returns empty string when finite timestamp overflows JS Date bounds', () => {
    assert.equal(formatTurnTimestamp(1e18), '');
    assert.equal(formatTurnTimestamp(-1e18), '');
  });
});
