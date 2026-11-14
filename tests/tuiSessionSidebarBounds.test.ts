import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { joinSessionSidebar, SIDEBAR_WIDTH } from '../src/tui/sessionSidebar.js';

describe('sessionSidebar bounds', () => {
  it('joinSessionSidebar normalizes non-finite and fractional mainWidth cleanly', () => {
    const row = 'x'.repeat(100);
    const side = '|'.padEnd(SIDEBAR_WIDTH, ' ');

    const [nanJoined] = joinSessionSidebar([row], [side], Number.NaN);
    assert.equal(nanJoined.length, 80 + SIDEBAR_WIDTH);

    const [shortNanJoined] = joinSessionSidebar(['hi'], [side], Number.NaN);
    assert.equal(shortNanJoined.length, 80 + SIDEBAR_WIDTH);

    const [fracJoined] = joinSessionSidebar(['abcdef'], [side], 3.9);
    assert.equal(fracJoined.slice(0, 3), 'abc');
    assert.equal(fracJoined.length, 3 + SIDEBAR_WIDTH);
  });
});
