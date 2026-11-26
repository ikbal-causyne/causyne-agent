import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StageSurface } from '../src/tui/stageSurface.js';
import { ChatRenderer } from '../src/tui/chatRenderer.js';
import { stripAnsi, visibleWidth } from '../src/tui/text.js';
import { renderTurnPreviewCard, overlayTurnPreviewCard } from '../src/tui/turnRail.js';

test('turn rail dots stay vertically centered in the viewport instead of following the bottom-aligned message row', () => {
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

    const vpRows = surface.stage.prev.slice(0, surface.viewport.height).map((r: string) => stripAnsi(r));
    const userRowIdx = vpRows.findIndex((r: string) => r.includes('hi'));
    const dotRowIdx = vpRows.findIndex((r: string) => r.includes('●'));
    const expectedCenter = Math.floor((surface.viewport.height - 1) / 2);

    assert.ok(userRowIdx > 40, `Expected bottom-aligned user message near bottom of 77-row stage, got row ${userRowIdx}`);
    assert.equal(dotRowIdx, expectedCenter, `Expected turn rail dot ● vertically centered at row ${expectedCenter}, got row ${dotRowIdx}`);
    assert.notEqual(dotRowIdx, userRowIdx, 'Left turn rail dot must stay centered rather than following the message row');
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

test('overlayTurnPreviewCard keeps right overview rail aligned at rowLen - 1 and clamps wide cards to screenWidth', () => {
  // With sidebar/rail, attachRail pads rows to mainWidth - 1 (79 cols when mainWidth = 80)
  const paddedRow = '   ' + 'a'.repeat(75) + '┃';
  assert.equal(visibleWidth(paddedRow), 79);
  const card = [
    '╭────────────────────╮',
    '│ Turn 1 preview     │',
    '╰────────────────────╯'
  ];
  const overlaid = overlayTurnPreviewCard([paddedRow, paddedRow, paddedRow], card, 1, 1, 80);
  for (let i = 0; i < overlaid.length; i++) {
    assert.equal(visibleWidth(overlaid[i]!), 79, `Row ${i} width must stay aligned at 79, not shift rail to 80`);
    assert.equal(stripAnsi(overlaid[i]!)[78], '┃');
  }

  // Narrow viewport: card wider than screenWidth must be clipped so it never spills into sidebar
  const narrowBase = ['   hi', '   there', '   ok'];
  const wideCard = renderTurnPreviewCard({
    turnIndex: 1,
    totalTurns: 1,
    userPrompt: 'hello world',
    assistantSummary: 'response',
    timestamp: 1000,
    formattedDate: 'Today',
    frameId: 1,
    startRow: 0
  }, 52);
  const narrowOut = overlayTurnPreviewCard(narrowBase, wideCard, 1, 1, 40);
  for (let i = 0; i < narrowOut.length; i++) {
    assert.ok(visibleWidth(narrowOut[i]!) <= 40, `Row ${i} width ${visibleWidth(narrowOut[i]!)} must not exceed screenWidth 40`);
  }
});

test('single-turn left dot stays vertically centered independent of prompt row, narrow resize clears turnRailLayout, and new user turns clear stale activeTurnIndex', () => {
  const out = {
    columns: 187,
    rows: 78,
    isTTY: true,
    write: () => true,
    on() {},
    removeListener() {}
  };
  const surface = new StageSurface({ out, env: { CAUSYNE_MOUSE: '0', CAUSYNE_RAIL: '1' } });
  assert.equal(surface.open(), true);
  try {
    surface.enterHome({ version: 'v1', provider: 'acp/opencode', model: 'deepseek', cwd: '/tmp/work' });
    surface.leaveHome(true);

    const renderer = new ChatRenderer({ out, transcript: surface.transcript });
    renderer.renderUserMessage('g');
    renderer.onNotice({ text: 'Analyzing & planning..' });
    renderer.renderAssistantMessage('What would you like me to do?\nDetail row');

    surface.present(['   ┃ prompt', '   Build C'], { row: 0, col: 4 });
    const mainW = surface.composeAvailableWidth();
    const vpRows = surface.stage.prev.slice(0, surface.viewport.height).map((r: string) => stripAnsi(r));
    const userRowIdx = vpRows.findIndex((r: string) => r.includes('g') && /[┃|]/.test(r));
    const expectedCenter = Math.floor((surface.viewport.height - 1) / 2);
    assert.ok(userRowIdx > 40, `expected bottom-aligned user prompt row, got ${userRowIdx}`);
    assert.equal(vpRows[expectedCenter]?.[1], '●', `left turn rail dot must sit vertically centered at row ${expectedCenter}`);
    assert.notEqual(vpRows[userRowIdx]?.[1], '●', `left turn rail dot must not anchor beside message row ${userRowIdx}`);
    assert.notEqual(vpRows[userRowIdx]?.[mainW - 2]?.trim(), '', `right overview marker must align on exact user prompt row ${userRowIdx}`);

    // Shrinking below rail threshold clears stale turnRailLayout and hover card state
    surface.hoveredTurnIndex = 1;
    surface.hoveredTurnAnchorY = expectedCenter;
    out.columns = 50;
    surface.resize();
    surface.present(['   ┃ prompt', '   Build C'], { row: 0, col: 4 });
    assert.equal(surface.turnRailLayout, null, 'turnRailLayout must clear below RAIL_MIN_WIDTH');
    assert.equal(surface.hoveredTurnIndex, null, 'hoveredTurnIndex must clear on resize/disablement');

    // Restore wide layout and verify a newly appended user turn clears sticky activeTurnIndex
    out.columns = 187;
    surface.resize();
    surface.activeTurnIndex = 1;
    renderer.renderUserMessage('second turn');
    assert.equal(surface.activeTurnIndex, null, 'new user turn must clear prior manual activeTurnIndex selection');
  } finally {
    surface.close();
  }
});


