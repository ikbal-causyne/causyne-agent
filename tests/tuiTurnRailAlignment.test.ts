import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StageSurface } from '../src/tui/stageSurface.js';
import { ChatRenderer } from '../src/tui/chatRenderer.js';
import { stripAnsi, visibleWidth } from '../src/tui/text.js';
import { renderTurnPreviewCard, overlayTurnPreviewCard } from '../src/tui/turnRail.js';

test('turn rail dots stay anchored to the bottom-aligned transcript in a full-height session instead of floating in upper empty space', () => {
  const out = {
    columns: 193,
    rows: 78,
    isTTY: true,
    write: () => true,
    on() {},
    removeListener() {}
  };
  const surface = new StageSurface({ out, env: { CAUSYNE_MOUSE: '0', CAUSYNE_RAIL: '1' } });
  assert.equal(surface.open(), true);
  try {
    surface.enterHome({ version: 'v1', provider: 'acp/opencode', model: 'deepseek-v4.1-flash-free', cwd: '/tmp/work' });
    surface.leaveHome(true);

    const renderer = new ChatRenderer({ out, transcript: surface.transcript });
    renderer.renderUserMessage('hi');
    renderer.renderAssistantMessage('Hi. What would you like to build or work on?');

    surface.present(['   ┃ try "review"', '   Build C'], { row: 0, col: 4 });

    const plainRows = surface.stage.prev.map((r: string) => stripAnsi(r));
    const userRowIdx = plainRows.findIndex((r: string) => r.includes('hi'));
    const dotRowIdx = plainRows.findIndex((r: string) => r.includes('●'));

    assert.ok(userRowIdx > 40, `Expected bottom-aligned user message near bottom of 77-row stage, got row ${userRowIdx}`);
    assert.ok(dotRowIdx >= userRowIdx - 1, `Expected turn rail dot ● near bottom-aligned transcript (row >= ${userRowIdx - 1}), but found floating at row ${dotRowIdx}`);
  } finally {
    surface.close();
  }
});

test('renderTurnPreviewCard keeps footer and body rows strictly within cardWidth when counter and date overflow innerWidth', () => {
  const card = renderTurnPreviewCard({
    turnIndex: 12,
    totalTurns: 25,
    userPrompt: 'Check\x1b[2J prompt',
    assistantSummary: 'Summary\x1b[31m text',
    timestamp: 1000,
    formattedDate: 'September 30, 2026 at 11:45 PM',
    frameId: 1,
    startRow: 0
  }, 38);

  for (let i = 0; i < card.length; i++) {
    assert.equal(visibleWidth(card[i]!), 38, `Row ${i} visibleWidth (${visibleWidth(card[i]!)}) must equal cardWidth 38`);
    assert.ok(!card[i]!.includes('\x1b[2J'), 'Card must sanitize terminal control sequences');
  }
});

test('overlayTurnPreviewCard does not teleport the last character of short transcript rows to the right rail column', () => {
  const baseRows = [
    '   ┃ hi',
    '   ▸ Causyne',
    '     Short reply',
    ''
  ];
  const card = [
    '╭────────────────────╮',
    '│ Turn 1 preview     │',
    '│ 1 of 1    10:00 AM │',
    '╰────────────────────╯'
  ];
  const overlaid = overlayTurnPreviewCard(baseRows, card, 1, 1, 80);
  for (let i = 0; i < overlaid.length; i++) {
    const plain = stripAnsi(overlaid[i]!).trimEnd();
    assert.ok(plain.endsWith('╮') || plain.endsWith('│') || plain.endsWith('╯'),
      `Row ${i} should end with card border without teleported character at col 79, got: "${plain}"`);
  }
});


