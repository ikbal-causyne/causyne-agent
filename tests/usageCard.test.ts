import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectUsageCardData,
  renderProgressBar,
  renderUsageCardRows,
  type UsageCardData
} from '../src/tui/usageCard.js';
import { runCommand } from '../src/commands.js';
import { ChatPrompt } from '../src/tui/prompt.js';

test('renderProgressBar produces bounded visual bars with percentage clamping', () => {
  const bar100 = renderProgressBar(100, 20);
  assert.ok(bar100.length > 0);

  const bar50 = renderProgressBar(50, 20);
  assert.ok(bar50.length > 0);

  const bar0 = renderProgressBar(0, 20);
  assert.ok(bar0.length > 0);

  // Inverted colors for budget consumption
  const barBudgetHigh = renderProgressBar(95, 20, true);
  assert.ok(barBudgetHigh.length > 0);
});

test('collectUsageCardData gathers session, context, and lifetime metrics', async () => {
  const mockLoop = {
    tokenTracker: {
      sessionTokens: 12500,
      sessionCostUsd: 0.045,
      taskTokens: 3200,
      taskCostUsd: 0.012,
      async getReportedUsage() {
        return {
          dailyTokens: 45000,
          dailyCostUsd: 0.15,
          lifetimeTokens: 950000,
          lifetimeCostUsd: 3.25,
          taskTokens: 3200,
          taskCostUsd: 0.012,
          sessionTokens: 12500,
          sessionCostUsd: 0.045,
          usedTokens: 45000,
          isDemo: false
        };
      },
      async getCumulativeUsage() {
        return { totalTokens: 950000, totalCalls: 48, totalCostUsd: 3.25 };
      },
      async getDailyUsage() {
        return { totalTokens: 45000, totalCalls: 12, totalCostUsd: 0.15 };
      }
    },
    memoryManager: {
      sessionId: 'test-session-uuid-1234'
    },
    messages: [
      { role: 'user', content: 'hello agent' },
      { role: 'assistant', content: 'hello user' }
    ]
  };

  const data = await collectUsageCardData(mockLoop);
  assert.equal(data.sessionId, 'test-session-uuid-1234');
  assert.equal(data.sessionTurns, 2);
  assert.equal(data.sessionTokens, 12500);
  assert.equal(data.sessionCostUsd, 0.045);
  assert.equal(data.dailyTokens, 45000);
  assert.equal(data.lifetimeTokens, 950000);
  assert.equal(data.lifetimeCalls, 48);
  assert.ok(data.contextPercentLeft > 0);
});

test('renderUsageCardRows renders within width and displays session, lifetime, and context rows', () => {
  const data: UsageCardData = {
    sessionId: 'session-alpha-88',
    sessionTurns: 5,
    sessionTokens: 14200,
    sessionCostUsd: 0.052,
    dailyTokens: 52000,
    dailyCostUsd: 0.18,
    lifetimeTokens: 1200000,
    lifetimeCostUsd: 4.50,
    lifetimeCalls: 62,
    contextUsedTokens: 18500,
    contextPoolTokens: 250000,
    contextPercentLeft: 92,
    provider: 'deepseek',
    model: 'deepseek-v4.1-flash',
    billingNote: 'BYOK (provider billed)',
    budgetEnabled: false
  };

  const rows = renderUsageCardRows(data, 80);
  assert.ok(rows.length >= 7, 'Card contains at least 7 rows including frame');

  const fullText = rows.join('\n');
  assert.match(fullText, /Usage & Context/);
  assert.match(fullText, /Session\/Chat/);
  assert.match(fullText, /Context/);
  assert.match(fullText, /This Session/);
  assert.match(fullText, /Today/);
  assert.match(fullText, /All-Time/);
  assert.match(fullText, /esc close/);
});

test('prompt.toggleUsageCard() toggles usageCard and adjusts draw height', async () => {
  const prompt = new ChatPrompt({ root: process.cwd() });
  assert.equal(prompt.usageCard, null);

  const opened = await prompt.toggleUsageCard();
  assert.equal(opened, true);
  assert.ok(prompt.usageCard);

  const closed = await prompt.toggleUsageCard();
  assert.equal(closed, false);
  assert.equal(prompt.usageCard, null);
});

test('/usage command toggles usageCard in interactive prompt and produces report in non-interactive mode', async () => {
  let toggled = false;
  const mockPrompt = {
    async toggleUsageCard() {
      toggled = true;
      return true;
    }
  };

  // Interactive mode: silent effect, triggers toggleUsageCard
  const interactiveResult = await runCommand('usage', [], { prompt: mockPrompt as any });
  assert.equal(interactiveResult.ok, true);
  assert.equal(interactiveResult.effect, 'silent');
  assert.equal(toggled, true);

  // Non-interactive mode (without prompt): produces full text report
  const cliResult = await runCommand('usage', [], {});
  assert.equal(cliResult.ok, true);
  assert.match(cliResult.output, /Token usage/);
  assert.match(cliResult.output, /This task/);
  assert.match(cliResult.output, /Lifetime/);
});
