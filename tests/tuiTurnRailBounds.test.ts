import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTurnRailCells,
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
});
