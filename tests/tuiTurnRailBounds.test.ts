import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveActiveTurnIndex, type SessionTurn } from '../src/tui/turnRail.js';

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
});
