import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderProgressBar, renderUsageCardRows } from '../src/tui/usageCard.js';
import { visibleWidth } from '../src/tui/text.js';

const sampleUsageData = () => ({
  sessionId: 'sess-1',
  sessionTurns: 2,
  sessionTokens: 100,
  sessionCostUsd: 0.01,
  dailyTokens: 100,
  dailyCostUsd: 0.01,
  lifetimeTokens: 100,
  lifetimeCostUsd: 0.01,
  lifetimeCalls: 1,
  contextUsedTokens: 100,
  contextPoolTokens: 1000,
  contextPercentLeft: 90,
  provider: 'openai',
  model: 'gpt-4o',
  billingNote: 'BYOK',
  budgetEnabled: false
});

describe('usageCard renderProgressBar finite bounds', () => {
  it('handles non-finite percent or barLength without throwing or collapsing to empty', () => {
    const barNaN = renderProgressBar(Number.NaN, 20);
    assert.equal(visibleWidth(barNaN), 20);

    assert.doesNotThrow(() => {
      const barInf = renderProgressBar(50, Number.POSITIVE_INFINITY);
      assert.equal(visibleWidth(barInf), 24);
    });
  });

  it('renderUsageCardRows clamps non-finite widths without throwing RangeError', () => {
    const data = sampleUsageData();
    assert.doesNotThrow(() => {
      const rowsInf = renderUsageCardRows(data, Number.POSITIVE_INFINITY);
      assert.equal(visibleWidth(rowsInf.at(-2)!), 80);
      const rowsNaN = renderUsageCardRows(data, Number.NaN);
      assert.equal(visibleWidth(rowsNaN.at(-2)!), 80);
    });
  });

  it('renderUsageCardRows aligns topBorder width to frameWidth', () => {
    const rows = renderUsageCardRows(sampleUsageData(), 80);
    assert.equal(visibleWidth(rows[0]!), 80);
  });
});
