import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { compactCount, formatCost, formatElapsed, StatusLine } from '../src/tui/statusLine.js';
import { visibleWidth } from '../src/tui/text.js';

describe('formatElapsed', () => {
  it('clamps negative and non-finite durations to zero seconds', () => {
    assert.equal(formatElapsed(-500), '0.0s');
    assert.equal(formatElapsed(-1), '0.0s');
    assert.equal(formatElapsed(Number.NaN), '0.0s');
    assert.equal(formatElapsed(Number.POSITIVE_INFINITY), '0.0s');
    assert.equal(formatElapsed(1500), '1.5s');
  });

  it('compactCount and formatCost clamp negative and non-finite inputs', () => {
    assert.equal(compactCount(Number.POSITIVE_INFINITY), '0');
    assert.equal(compactCount(-10), '0');
    assert.equal(formatCost(Number.POSITIVE_INFINITY), '$0');
    assert.equal(formatCost(Number.NaN), '$0');
  });

  it('StatusLine clamps non-finite widths without throwing RangeError', () => {
    const status = new StatusLine().setSession({
      cwd: '/tmp/project',
      model: 'gpt-4o',
      contextChars: 4000,
      contextLimit: 40000
    });
    assert.doesNotThrow(() => {
      const idleInf = status.renderIdle({ width: Number.POSITIVE_INFINITY, hint: 'help' });
      assert.ok(visibleWidth(idleInf) <= 79);
      const idleNaN = status.renderIdle({ width: Number.NaN, hint: 'help' });
      assert.ok(idleNaN.includes('  '));

      const liveInf = status.render({ message: 'working', width: Number.POSITIVE_INFINITY });
      assert.ok(visibleWidth(liveInf) <= 79);
      const liveNaN = status.render({ message: 'working', width: Number.NaN });
      assert.ok(liveNaN.includes('  '));
    });
  });
});
