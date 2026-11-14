import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { getAngle, renderCausyneRotor } from '../src/tui/CausyneRotor.js';

describe('CausyneRotor finite bounds', () => {
  it('getAngle and renderCausyneRotor sanitize non-finite elapsedMs, columns, and rows', () => {
    assert.ok(Number.isFinite(getAngle(Number.NaN)));
    assert.ok(Number.isFinite(getAngle(Number.POSITIVE_INFINITY)));

    const frame = renderCausyneRotor(Number.NaN, {
      columns: Number.NaN,
      rows: Number.POSITIVE_INFINITY,
      label: 'run'
    });
    assert.ok(frame.length > 0);
    assert.ok(frame.split('\n').length >= 6);
  });
});
