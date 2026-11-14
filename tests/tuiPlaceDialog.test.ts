import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { placeDialog } from '../src/tui/homeView.js';

describe('placeDialog', () => {
  it('never produces negative or NaN caret coordinates when rows are empty or inputs are non-finite', () => {
    const empty = placeDialog([], 80, 1, 0, 0);
    assert.equal(empty.caretRow, 0);
    assert.equal(empty.caretCol, 0);

    const nonFinite = placeDialog(['line'], Number.NaN, Number.NaN, Number.NaN, Number.NaN);
    assert.equal(Number.isFinite(nonFinite.caretRow), true);
    assert.equal(Number.isFinite(nonFinite.caretCol), true);
    assert.equal(nonFinite.caretRow, 0);
    assert.equal(nonFinite.caretCol, 0);
  });
});
