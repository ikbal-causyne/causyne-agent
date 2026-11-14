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

  it('setSession and onUsage ignore non-finite and negative counters', () => {
    const status = new StatusLine().setSession({
      contextLimit: 10000,
      contextChars: 2000
    });
    status.onUsage({ taskTokens: 500, costUsd: 0.02, cachedTokens: 100 });
    status.setSession({
      contextLimit: Number.POSITIVE_INFINITY,
      contextChars: -50
    });
    status.onUsage({
      taskTokens: Number.POSITIVE_INFINITY,
      costUsd: Number.POSITIVE_INFINITY,
      cachedTokens: Number.NaN,
      contextChars: Number.POSITIVE_INFINITY,
      contextLimitChars: Number.NaN
    });
    assert.equal(status.contextLimit, 10000);
    assert.equal(status.contextChars, 2000);
    assert.equal(status.turnTokens, 500);
    assert.equal(status.turnCost, 0.02);
    assert.equal(status.cachedTokens, 0);
  });

  it('StatusLine.render omits non-finite elapsedMs/steps and floors fractional steps', () => {
    const status = new StatusLine();
    let recordedNowMs: number | undefined;
    status.onTick = (nowMs) => {
      recordedNowMs = nowMs;
    };

    const renderedInf = status.render({
      message: 'working',
      elapsedMs: Number.POSITIVE_INFINITY,
      steps: Number.POSITIVE_INFINITY,
      tick: Number.NaN,
      width: 100
    });
    assert.doesNotMatch(renderedInf, /Infinity|\bNaN\b|0\.0s|step /);
    assert.equal(recordedNowMs, undefined);

    const renderedFrac = status.render({
      message: 'working',
      elapsedMs: 1200,
      steps: 2.9,
      width: 100
    });
    assert.match(renderedFrac, /1\.2s/);
    assert.match(renderedFrac, /step 2\b/);
    assert.equal(recordedNowMs, 1200);
  });
});
