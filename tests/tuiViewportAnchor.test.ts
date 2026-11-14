import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { captureReadingAnchor, restoreReadingAnchor } from '../src/tui/viewportAnchor.js';

describe('viewportAnchor reading anchor', () => {
  it('restoreReadingAnchor finds un-IDd marker by originalIndex even when an earlier invalid marker was filtered', () => {
    const markers = [
      { row: -1 },
      { row: 10 },
      { row: 40 }
    ];
    const anchor = captureReadingAnchor(markers, 42, 80);
    assert.ok(anchor);
    assert.equal(anchor.id, null);
    assert.equal(anchor.index, 2);

    const reflowedMarkers = [
      { row: -1 },
      { row: 15 },
      { row: 50 }
    ];
    const restored = restoreReadingAnchor(anchor, reflowedMarkers, 100, 20);
    assert.ok(restored >= 50, `expected restored row >= 50, got ${restored}`);
  });
});
