import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { placeDialog, placeHome } from '../src/tui/homeView.js';

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

  it('placeHome guards non-finite dimensions and caret coordinates without RangeError', () => {
    assert.doesNotThrow(() => {
      const nanHome = placeHome({}, ['> '], Number.NaN, Number.NaN, Number.NaN, Number.NaN);
      assert.ok(nanHome.rows.length > 0);
      assert.equal(Number.isFinite(nanHome.caretRow), true);
      assert.equal(Number.isFinite(nanHome.caretCol), true);

      const infHome = placeHome({}, ['> '], Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, 0, 2);
      assert.ok(infHome.rows.length > 0);
      assert.equal(Number.isFinite(infHome.caretRow), true);
      assert.equal(Number.isFinite(infHome.caretCol), true);
    });
  });

  it('placeDialog floors fractional columns and caret coordinates', () => {
    const placed = placeDialog(['line 1', 'line 2', 'line 3'], 10.9, 6.8, 1.9, 9.8);
    assert.equal(Number.isInteger(placed.caretRow), true);
    assert.equal(Number.isInteger(placed.caretCol), true);
    assert.equal(placed.caretCol, 8);
  });
});
