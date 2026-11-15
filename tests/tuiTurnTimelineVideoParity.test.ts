import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTurnRailCells, handleTurnRailMouse } from '../src/tui/turnRail.js';
import { renderTurnTimelineCard, StageSurface } from '../src/tui/stageSurface.js';
import { stripAnsi, visibleWidth } from '../src/tui/text.js';

const turns = Array.from({ length: 90 }, (_, index) => ({
  turnIndex: index + 1, totalTurns: 90, userPrompt: 'Conversation turn ' + (index + 1),
  assistantSummary: 'Assistant response', timestamp: Date.UTC(2026, 10, 15, 12, index),
  formattedDate: 'Nov 15', frameId: index + 1, startRow: index * 12,
  transcriptHeight: 1200
}));

test('compressed dots represent timestamped groups instead of losing individual turns', () => {
  const rail = buildTurnRailCells(turns, 16, 89, null, 0);
  const groups = new Map<number, number[]>();
  for (const [id, row] of rail.layout.dotRows.entries()) {
    const bucket = groups.get(row) || [];
    bucket.push(id);
    groups.set(row, bucket);
  }
  assert.equal([...groups.values()].flat().length, 90);
  assert.ok([...groups.values()].some(group => group.length > 1));
  for (const row of groups.keys()) {
    assert.match(stripAnsi(rail.cells[row] || ''), /[•●]/, 'every cluster needs a visible dot');
  }
  assert.equal(rail.layout.rowToTurn.get(rail.layout.dotRows.get(89)!), 89);
});

test('timeline card displays a time range and clickable list of grouped turns without overflowing', () => {
  const preview = renderTurnTimelineCard(turns.slice(0, 8), 48, 14);
  assert.equal(preview.entries.length, 8);
  assert.equal(preview.entryStart, 4);
  assert.equal(preview.rows.length, 13);
  assert.match(stripAnsi(preview.rows[2]), /8 turns/);
  assert.ok(preview.rows[1].includes('\x1b[48;2;28;28;32m'), 'popover must use actual ANSI background');
  assert.ok(preview.rows.every(row => visibleWidth(row) <= 48), 'no row can cause terminal wrap');
  assert.match(stripAnsi(preview.rows[4]), /Conversation turn 1/);
  assert.match(stripAnsi(preview.rows[11]), /Conversation turn 8/);

  const paged = renderTurnTimelineCard(turns, 48, 12, 999);
  assert.equal(paged.entries.length, 7);
  assert.equal(paged.entries[6].turnIndex, 90);
  assert.equal(paged.maxOffset, 83);
  assert.equal(paged.rows.length, 12);
});

test('popover entries navigate to their own conversation frames and ignore non-entry clicks', () => {
  let selected: number | undefined;
  const entries = turns.slice(12, 17);
  const railRow = 5;
  const layout = {
    railX: 1, stageTop: 4, viewportHeight: 28, dotRows: new Map([[13, railRow]]),
    rowToTurn: new Map([[railRow, 13]]), turns,
    cardRect: { x: 4, y: 7, width: 48, height: 10, turnIndex: 13, entries, entryStart: 4 }
  };
  const surface: any = {
    turnRailLayout: layout, hoveredTurnIndex: 13, hoveredTurnAnchorY: railRow,
    viewport: { scrollTo: (row: number) => { selected = row; }, toBottom: () => { selected = -1; } }
  };
  const host = { draw() {} };
  const header = { mouse: { x: 12, y: 4 + 7 + 1, button: 0, pressed: true } };
  assert.equal(handleTurnRailMouse(header, surface, host), true);
  assert.equal(selected, undefined, 'header click does not navigate');
  const chooseFourth = { mouse: { x: 12, y: 4 + 7 + 4 + 3, button: 0, pressed: true } };
  assert.equal(handleTurnRailMouse(chooseFourth, surface, host), true);
  assert.equal(selected, entries[3].startRow);
  assert.equal(surface.activeTurnIndex, entries[3].turnIndex);
});

test('stage attaches actual groups to left-side dots and renders their list on hover', () => {
  const out = { columns: 180, rows: 46, isTTY: true,
    write: () => true, on() {}, removeListener() {} };
  const surface = new StageSurface({ out, env: {} });
  assert.equal(surface.open(), true);
  try {
    for (let i = 1; i <= 90; i++) {
      surface.commit('user', () => ['User message ' + i], { messageText: 'User message ' + i });
    }
    surface.present(['COMPOSER'], { row: 0, col: 0 });
    const grouped = [...surface.turnRailLayout.rowToTurns.entries()].find(([, group]) => group.length > 1);
    assert.ok(grouped, 'many user turns should compress into visible groups');
    const [row, group] = grouped!;
    surface.hoveredTurnIndex = group[0].turnIndex;
    surface.hoveredTurnAnchorY = row;
    surface.present(['COMPOSER'], { row: 0, col: 0 });
    const rect = surface.turnRailLayout.cardRect;
    assert.ok(rect && rect.entries && rect.entries.length > 1, 'grouped history card must expose selectable items');
  } finally {
    surface.close();
  }
});
