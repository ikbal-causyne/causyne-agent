import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatPrompt } from '../src/tui/prompt.js';
import { runCommand } from '../src/commands.js';
import { handlePromptEscape } from '../src/tui/composerControls.js';
import { stripAnsi, visibleWidth } from '../src/tui/text.js';

function promptHarness() {
  const prompt = new ChatPrompt({ root: process.cwd(), isCommand: text => text.startsWith('/') });
  const delivered = [];
  prompt.history = { add() {} };
  prompt.erase = () => {};
  prompt.scheduleDraw = () => {};
  prompt.draw = () => {};
  prompt.startTick = () => {};
  prompt.stopTick = () => {};
  prompt.renderSubmittedUserMessage = () => {};
  prompt.waiter = value => delivered.push(value);
  return { prompt, delivered };
}

test('pinned usage remains visible after a normal submission and busy transitions', () => {
  const { prompt, delivered } = promptHarness();
  const original = { lifetimeTokens: 5 };
  prompt.usageCard = original;
  prompt.editor.setText('run the tests and report failures');
  prompt.submit();
  assert.equal(prompt.usageCard, original);
  assert.deepEqual(delivered, ['run the tests and report failures']);
  prompt.setBusy(true);
  assert.equal(prompt.usageCard, original);
  prompt.setBusy(false);
  assert.equal(prompt.usageCard, original);
});

test('queued messages and ordinary slash commands do not dismiss a pinned card', () => {
  const { prompt } = promptHarness();
  const original = { lifetimeTokens: 5 };
  prompt.usageCard = original;
  prompt.setBusy(true);
  prompt.editor.setText('next request');
  prompt.submit();
  assert.equal(prompt.usageCard, original);
  assert.equal(prompt.queue.length, 1);
  prompt.setBusy(false);
  prompt.waiter = () => {};
  prompt.editor.setText('/help');
  prompt.submit();
  assert.equal(prompt.usageCard, original);
});

test('/status is an inline persistent panel, not a modal that prevents typing', async () => {
  const { prompt, delivered } = promptHarness();
  assert.equal(prompt.toggleStatusCard(), true);
  assert.ok(prompt.statusCard);
  assert.equal(prompt.layer, null);
  const rows = prompt.statusCardRows(80);
  assert.ok(rows.some(row => stripAnsi(row).includes('Status')));
  assert.ok(rows.some(row => stripAnsi(row).includes('esc close')));
  for (const row of rows.slice(0, -1)) assert.equal(visibleWidth(row), 80);
  prompt.editor.setText('keep working');
  prompt.submit();
  assert.ok(prompt.statusCard);
  assert.deepEqual(delivered, ['keep working']);
  prompt.setBusy(true);
  assert.ok(prompt.statusCard);
  prompt.setBusy(false);
  assert.ok(prompt.statusCard);
  assert.equal(prompt.toggleStatusCard(), false);
  assert.equal(prompt.statusCard, null);
  const result = await runCommand('status', [], { prompt, loop: null });
  assert.equal(result.effect, 'silent');
  assert.ok(prompt.statusCard);
  assert.equal(prompt.layer, null);
});

test('explicit Esc closes a pinned panel before interrupting an active agent', () => {
  const { prompt } = promptHarness();
  let interrupts = 0;
  prompt.onInterrupt = () => { interrupts++; };
  prompt.busy = true;
  prompt.usageCard = { lifetimeTokens: 5 };
  handlePromptEscape(prompt, () => ['interrupted']);
  assert.equal(prompt.usageCard, null);
  assert.equal(interrupts, 0);
  prompt.toggleStatusCard();
  handlePromptEscape(prompt, () => ['interrupted']);
  assert.equal(prompt.statusCard, null);
  assert.equal(interrupts, 0);
});

test('typing /status toggles the persistent status card without entering command queue', () => {
  const { prompt, delivered } = promptHarness();
  prompt.editor.setText('/status');
  prompt.submit();
  assert.ok(prompt.statusCard);
  assert.equal(delivered.length, 0);
  prompt.editor.setText('/status');
  prompt.submit();
  assert.equal(prompt.statusCard, null);
  assert.equal(delivered.length, 0);
});

test('an in-flight usage snapshot cannot reopen after explicit close or panel switch', async () => {
  const { prompt } = promptHarness();
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const tracker = {
    sessionTokens: 3, sessionCostUsd: 0,
    async getReportedUsage() { await blocked; return {}; },
    async getCumulativeUsage() { return { totalTokens: 3, totalCalls: 1, totalCostUsd: 0 }; },
    async getDailyUsage() { return { totalTokens: 3, totalCalls: 1, totalCostUsd: 0 }; }
  };
  const loop = { tokenTracker: tracker, messages: [], memoryManager: { sessionId: 'test' } };
  const pending = prompt.toggleUsageCard(loop);
  assert.equal(prompt.usageCardLoading, true);
  prompt.toggleStatusCard(loop);
  release();
  assert.equal(await pending, false);
  assert.equal(prompt.usageCard, null);
  assert.ok(prompt.statusCard);
  const second = prompt.toggleUsageCard(loop);
  assert.equal(await second, true);
  assert.ok(prompt.usageCard);
  prompt.closeUsageCard();
  assert.equal(prompt.usageCard, null);
});
