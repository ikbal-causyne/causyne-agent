import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectUsageCardData, renderUsageCardRows } from '../src/tui/usageCard.js';
import { visibleWidth, stripAnsi } from '../src/tui/text.js';

function usageLoop(config = {}) {
  return {
    config: { provider: 'acp/opencode', model: 'opencode/deepseek-v4.1-flash-free', ...config },
    tokenTracker: {
      sessionTokens: 18551, sessionCostUsd: 0,
      getReportedUsage: async () => ({ sessionTokens: 18551, sessionCostUsd: 0 }),
      getDailyUsage: async () => ({ date: '2026-11-16', totalTokens: 18551, totalCalls: 24, totalCostUsd: 0 }),
      getCumulativeUsage: async () => ({ totalTokens: 103928594, totalCalls: 3446106, totalCostUsd: 8.1787 })
    },
    messages: [{ role: 'user', content: 'hello' }, { role: 'assistant', content: 'hi' }],
    memoryManager: { sessionId: 's_mwi6iyn5_a4b4fc' }
  };
}

test('/usage prefers the active ACP peer model and explicitly marks its context as inferred', async () => {
  const data = await collectUsageCardData(usageLoop());
  assert.equal(data.provider, 'acp/opencode');
  assert.equal(data.model, 'opencode/deepseek-v4.1-flash-free');
  assert.equal(data.contextLimitSource, 'inferred');
  assert.equal(data.sessionMetricsAvailable, true);
  assert.equal(data.contextPoolTokens, 128000);
  assert.equal(data.lifetimeTokens, 103928594);
  assert.equal(data.lifetimeCalls, 3446106);
  const body = stripAnsi(renderUsageCardRows(data, 100).join('\n'));
  assert.match(body, /Context \(est\.\)/);
  assert.match(body, /inferred cap/);
  assert.match(body, /Today \(local\)/);
  assert.match(body, /not provider billing/);
  assert.match(body, /Cost \(estimate\)/);
  assert.doesNotMatch(body, /Today \(24h\)/);
});

test('configured limits are separated from guessed model limits', async () => {
  const data = await collectUsageCardData(usageLoop({ contextTokens: 8192 }));
  assert.equal(data.contextPoolTokens, 8192);
  assert.equal(data.contextLimitSource, 'configured');
  assert.match(stripAnsi(renderUsageCardRows(data, 100).join('\n')), /configured cap/);
});

test('usage panel never exceeds its terminal width, even with the long ACP model identifier', async () => {
  const data = await collectUsageCardData(usageLoop());
  for (const width of [24, 40, 52, 65, 80, 100, 156]) {
    const rows = renderUsageCardRows(data, width);
    for (let i = 0; i < rows.length - 1; i++) {
      assert.equal(visibleWidth(rows[i]), width, `row ${i} at ${width} columns wraps or shifts the stage`);
    }
    assert.equal(rows.at(-1), '');
    assert.ok(rows.length <= 14);
  }
});

test('missing live tracker is not fabricated as zero session usage', async () => {
  const data = await collectUsageCardData({
    config: { provider: 'acp/opencode', model: 'opencode/deepseek-v4.1-flash-free' },
    memoryManager: { sessionId: 'missing-telemetry', loadHistory: () => [] }
  });
  assert.equal(data.sessionMetricsAvailable, false);
  assert.match(stripAnsi(renderUsageCardRows(data, 80).join('\n')), /unavailable/);
});
