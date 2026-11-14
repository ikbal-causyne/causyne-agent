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

  it('renderUsageCardRows sanitizes non-finite metrics instead of printing NaN or Infinity', () => {
    const data = {
      ...sampleUsageData(),
      contextUsedTokens: Number.POSITIVE_INFINITY,
      contextPercentLeft: Number.NaN,
      sessionCostUsd: Number.POSITIVE_INFINITY,
      dailyCostUsd: Number.NaN,
      lifetimeCostUsd: Number.POSITIVE_INFINITY
    };
    const text = renderUsageCardRows(data, 80).join('\n');
    assert.doesNotMatch(text, /\bNaN\b|Infinity|∞/);
  });

  it('renderUsageCardRows sanitizes non-finite or missing budgetPercentUsed and budgetLimitTokens', () => {
    const nanBudget = {
      ...sampleUsageData(),
      budgetEnabled: true,
      budgetLimitTokens: 1000,
      budgetPercentUsed: Number.NaN
    };
    const nanText = renderUsageCardRows(nanBudget, 80).join('\n');
    assert.doesNotMatch(nanText, /\bNaN\b|undefined|Infinity/);
    assert.match(nanText, /0% used/);

    const missingBudgetPct = {
      ...sampleUsageData(),
      budgetEnabled: true,
      budgetLimitTokens: 1000
    };
    const missingText = renderUsageCardRows(missingBudgetPct, 80).join('\n');
    assert.doesNotMatch(missingText, /undefined/);
    assert.match(missingText, /0% used/);

    const infLimit = {
      ...sampleUsageData(),
      budgetEnabled: true,
      budgetLimitTokens: Number.POSITIVE_INFINITY,
      budgetPercentUsed: 10
    };
    const infText = renderUsageCardRows(infLimit, 80).join('\n');
    assert.doesNotMatch(infText, /Daily Budget/);
  });

  it('renderUsageCardRows sanitizes non-finite sessionTurns cleanly', () => {
    const data = {
      ...sampleUsageData(),
      sessionTurns: Number.NaN
    };
    const text = renderUsageCardRows(data, 80).join('\n');
    assert.doesNotMatch(text, /\bNaN\b|Infinity/);
    assert.match(text, /\(0 messages\)/);
  });

  it('collectUsageCardData sanitizes non-finite tracker metrics and budgetPercentUsed', async () => {
    const { collectUsageCardData } = await import('../src/tui/usageCard.js');
    const { loadConfig, saveConfig } = await import('../src/config.js');
    const prevConfig = loadConfig();
    try {
      saveConfig({
        ...(prevConfig as Record<string, unknown>),
        tokenBudget: { enabled: true, maxTokensPerDay: 1000 }
      });
      const mockLoop = {
        tokenTracker: {
          sessionTokens: Number.POSITIVE_INFINITY,
          sessionCostUsd: Number.POSITIVE_INFINITY,
          taskTokens: 10,
          taskCostUsd: 0.01,
          async getReportedUsage() {
            return {};
          },
          async getCumulativeUsage() {
            return {
              totalTokens: Number.NaN,
              totalCalls: Number.POSITIVE_INFINITY,
              totalCostUsd: Number.POSITIVE_INFINITY
            };
          },
          async getDailyUsage() {
            return {
              totalTokens: Number.NaN,
              totalCalls: 1,
              totalCostUsd: Number.POSITIVE_INFINITY
            };
          }
        },
        memoryManager: { sessionId: 'finite-test' },
        messages: []
      };

      const data = await collectUsageCardData(mockLoop);
      assert.equal(Number.isFinite(data.sessionTokens), true);
      assert.equal(Number.isFinite(data.sessionCostUsd), true);
      assert.equal(Number.isFinite(data.dailyTokens), true);
      assert.equal(Number.isFinite(data.dailyCostUsd), true);
      assert.equal(Number.isFinite(data.lifetimeTokens), true);
      assert.equal(Number.isFinite(data.lifetimeCostUsd), true);
      assert.equal(Number.isFinite(data.lifetimeCalls), true);
      assert.equal(Number.isFinite(data.budgetLimitTokens), true);
      assert.equal(Number.isFinite(data.budgetPercentUsed), true);
      assert.equal(data.budgetPercentUsed, 0);
    } finally {
      saveConfig(prevConfig);
    }
  });
});
