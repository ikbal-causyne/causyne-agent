import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Transcript } from '../src/tui/transcript.js';
import { stripAnsi } from '../src/tui/text.js';
import {
  collectSessionTurns,
  buildTurnRailCells,
  renderTurnPreviewCard,
  overlayTurnPreviewCard,
  handleTurnRailMouse
} from '../src/tui/turnRail.js';

test('collectSessionTurns extracts user prompts, assistant summaries, and timestamps', () => {
  const transcript = new Transcript();

  // Turn 1
  transcript.append({
    kind: 'user',
    produce: () => ['jalankan script kemudian pelajari semua conversation...'],
    meta: { messageText: 'jalankan script kemudian pelajari semua conversation...' }
  });
  transcript.append({
    kind: 'assistant',
    produce: () => ['Skrip ekstraktor universal telah berhasil dijalankan kembali...'],
    meta: { messageText: 'Skrip ekstraktor universal telah berhasil dijalankan kembali...' }
  });

  // Turn 2
  transcript.append({
    kind: 'user',
    produce: () => ['apakah sudah publish ke npm juga via github action ?'],
    meta: { messageText: 'apakah sudah publish ke npm juga via github action ?' }
  });
  transcript.append({
    kind: 'assistant',
    produce: () => ['Paket telah dipublikasikan ke npm versi 1.20.13.'],
    meta: { messageText: 'Paket telah dipublikasikan ke npm versi 1.20.13.' }
  });

  const turns = collectSessionTurns(transcript, 80);
  assert.equal(turns.length, 2);
  assert.equal(turns[0]?.turnIndex, 1);
  assert.equal(turns[0]?.totalTurns, 2);
  assert.equal(turns[0]?.userPrompt, 'jalankan script kemudian pelajari semua conversation...');
  assert.equal(turns[0]?.assistantSummary, 'Skrip ekstraktor universal telah berhasil dijalankan kembali...');
  assert.ok(turns[0]?.formattedDate);

  assert.equal(turns[1]?.turnIndex, 2);
  assert.equal(turns[1]?.totalTurns, 2);
  assert.equal(turns[1]?.userPrompt, 'apakah sudah publish ke npm juga via github action ?');
  assert.equal(turns[1]?.assistantSummary, 'Paket telah dipublikasikan ke npm versi 1.20.13.');
});

test('buildTurnRailCells renders dots and highlights active or hovered turn', () => {
  const mockTurns = [
    { turnIndex: 1, totalTurns: 3, userPrompt: 'turn 1', assistantSummary: '', timestamp: 1000, formattedDate: '10:00 AM', frameId: 1, startRow: 0 },
    { turnIndex: 2, totalTurns: 3, userPrompt: 'turn 2', assistantSummary: '', timestamp: 2000, formattedDate: '10:05 AM', frameId: 2, startRow: 10 },
    { turnIndex: 3, totalTurns: 3, userPrompt: 'turn 3', assistantSummary: '', timestamp: 3000, formattedDate: '10:10 AM', frameId: 3, startRow: 20 }
  ];

  const result = buildTurnRailCells(mockTurns, 10, 3, 2);
  assert.equal(result.cells.length, 10);
  assert.equal(result.layout.dotRows.size, 3);
  assert.equal(result.layout.rowToTurn.size, 3);

  // Hovered turn 2 should have bright silver ●
  const hoveredRow = result.layout.dotRows.get(2)!;
  assert.ok(result.cells[hoveredRow]?.includes('●'));

  // Active turn 3 should have bright white ●
  const activeRow = result.layout.dotRows.get(3)!;
  assert.ok(result.cells[activeRow]?.includes('●'));
});

test('renderTurnPreviewCard renders box with user prompt, assistant preview and counter', () => {
  const turn = {
    turnIndex: 3,
    totalTurns: 12,
    userPrompt: 'jalankan script kemudian pelajari semua conversation termasuk conversation...',
    assistantSummary: 'Skrip ekstraktor universal telah berhasil dijalankan kembali dan memperbarui berkas digest secara penuh ke HOLD/private-...',
    timestamp: Date.now(),
    formattedDate: 'October 29, 2026 at 11:14 PM',
    frameId: 10,
    startRow: 35
  };

  const card = renderTurnPreviewCard(turn, 48);
  assert.ok(card.length >= 6);
  const plainText = card.map(stripAnsi).join('\n');

  assert.ok(plainText.includes('╭'));
  assert.ok(plainText.includes('╰'));
  assert.ok(plainText.includes('jalankan script'));
  assert.ok(plainText.includes('Skrip ekstraktor universal'));
  assert.ok(plainText.includes('3 of 12'));
  assert.ok(plainText.includes('October 29, 2026 at 11:14 PM'));
});

test('overlayTurnPreviewCard places card adjacent to rail without exceeding bounds', () => {
  const baseRows = [
    'Row 0: Lorem ipsum dolor sit amet               |',
    'Row 1: Consectetur adipiscing elit              |',
    'Row 2: Sed do eiusmod tempor incididunt         |',
    'Row 3: Ut labore et dolore magna aliqua         |',
    'Row 4: Ut enim ad minim veniam                  |',
    'Row 5: Quis nostrud exercitation ullamco        |',
    'Row 6: Laboris nisi ut aliquip ex ea commodo    |',
    'Row 7: Duis aute irure dolor in reprehenderit   |'
  ];

  const card = [
    '╭───────────╮',
    '│ Card row 1│',
    '│ 1 of 5    │',
    '╰───────────╯'
  ];

  const overlaid = overlayTurnPreviewCard(baseRows, card, 3, 48, 80);
  assert.equal(overlaid.length, baseRows.length);
  const plain = overlaid.map(stripAnsi).join('\n');
  assert.ok(plain.includes('Card row 1'));
  assert.ok(plain.includes('1 of 5'));
});

test('handleTurnRailMouse updates hovered turn and handles click navigation', () => {
  let scheduled = false;
  let drawn = false;
  let scrolledTo: number | null = null;

  const mockHost = {
    scheduleDraw: () => { scheduled = true; },
    draw: () => { drawn = true; }
  };

  const dotRows = new Map([[1, 2], [2, 5]]);
  const rowToTurn = new Map([[2, 1], [5, 2]]);
  const mockSurface = {
    turnRailLayout: {
      railX: 40,
      stageTop: 0,
      viewportHeight: 10,
      dotRows,
      rowToTurn,
      turns: [
        { turnIndex: 1, totalTurns: 2, userPrompt: 'T1', assistantSummary: '', timestamp: 1, formattedDate: '10:00', frameId: 1, startRow: 0 },
        { turnIndex: 2, totalTurns: 2, userPrompt: 'T2', assistantSummary: '', timestamp: 2, formattedDate: '10:05', frameId: 2, startRow: 25 }
      ]
    },
    hoveredTurnIndex: null,
    hoveredTurnAnchorY: null,
    viewport: {
      scrollTo: (row: number) => { scrolledTo = row; }
    }
  };

  // 1. Mouse motion over dot 1 (row 2, col 40)
  const hoverEvent = {
    mouse: { x: 40, y: 2, button: 0, pressed: false },
    sequence: '\x1b[<35;41;3M' // motion report (code 35)
  };
  const hoverHandled = handleTurnRailMouse(hoverEvent, mockSurface, mockHost);
  assert.equal(hoverHandled, true);
  assert.equal(mockSurface.hoveredTurnIndex, 1);
  assert.equal(scheduled, true);

  // 2. Mouse click over dot 2 (row 5, col 40)
  const clickEvent = {
    mouse: { x: 40, y: 5, button: 0, pressed: true },
    sequence: '\x1b[<0;41;6M' // left click press
  };
  const clickHandled = handleTurnRailMouse(clickEvent, mockSurface, mockHost);
  assert.equal(clickHandled, true);
  assert.equal(scrolledTo, 25);
});

