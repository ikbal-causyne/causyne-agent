import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Transcript } from '../src/tui/transcript.js';
import { stripAnsi } from '../src/tui/text.js';
import {
  collectSessionTurns,
  buildTurnRailCells,
  renderTurnPreviewCard,
  overlayTurnPreviewCard,
  handleTurnRailMouse,
  resolveActiveTurnIndex,
  sliceFromColumn
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
  assert.equal(mockSurface.activeTurnIndex, 2);
});

test('resolveActiveTurnIndex correctly resolves active turn from viewport scroll', () => {
  const mockTurns = [
    { turnIndex: 1, totalTurns: 3, userPrompt: 'turn 1', assistantSummary: '', timestamp: 1000, formattedDate: '10:00 AM', frameId: 1, startRow: 0 },
    { turnIndex: 2, totalTurns: 3, userPrompt: 'turn 2', assistantSummary: '', timestamp: 2000, formattedDate: '10:05 AM', frameId: 2, startRow: 20 },
    { turnIndex: 3, totalTurns: 3, userPrompt: 'turn 3', assistantSummary: '', timestamp: 3000, formattedDate: '10:10 AM', frameId: 3, startRow: 45 }
  ];

  assert.equal(resolveActiveTurnIndex([], 0), 0);
  assert.equal(resolveActiveTurnIndex(mockTurns, 0, 10), 1);
  assert.equal(resolveActiveTurnIndex(mockTurns, 18, 10), 2);
  assert.equal(resolveActiveTurnIndex(mockTurns, 50, 10), 3);
});

test('sliceFromColumn safely slices terminal columns while preserving ANSI escapes', () => {
  const plain = 'Hello world, this is a test';
  assert.equal(sliceFromColumn(plain, 6), 'world, this is a test');

  const colored = '\x1b[32mHello \x1b[34mWorld\x1b[0m';
  const sliced = sliceFromColumn(colored, 6);
  assert.ok(sliced.includes('World'));
});

test('left-margin turn rail hit testing and rightward preview card overlay', () => {
  let scheduled = false;
  let scrolledTo: number | null = null;

  const mockSurface = {
    turnRailLayout: {
      railX: 1, // Left margin (dots in col 1)
      stageTop: 0,
      viewportHeight: 12,
      dotRows: new Map([[1, 1], [2, 4], [3, 8]]),
      rowToTurn: new Map([[1, 1], [4, 2], [8, 3]]),
      turns: [
        { turnIndex: 1, totalTurns: 3, userPrompt: 'T1', assistantSummary: 'A1', timestamp: 1, formattedDate: '10:00', frameId: 1, startRow: 0 },
        { turnIndex: 2, totalTurns: 3, userPrompt: 'T2', assistantSummary: 'A2', timestamp: 2, formattedDate: '10:05', frameId: 2, startRow: 20 },
        { turnIndex: 3, totalTurns: 3, userPrompt: 'T3', assistantSummary: 'A3', timestamp: 3, formattedDate: '10:10', frameId: 3, startRow: 40 }
      ]
    },
    hoveredTurnIndex: null,
    hoveredTurnAnchorY: null,
    activeTurnIndex: 3,
    viewport: {
      scrollTo: (row: number) => { scrolledTo = row; }
    }
  };

  const mockHost = {
    scheduleDraw: () => { scheduled = true; },
    draw: () => {}
  };

  // Hover over left margin dot 2 (x = 1, y = 4)
  const hoverEvent = {
    mouse: { x: 1, y: 4, button: 0, pressed: false },
    sequence: '\x1b[<35;2;5M'
  };
  const handled = handleTurnRailMouse(hoverEvent, mockSurface, mockHost);
  assert.equal(handled, true);
  assert.equal(mockSurface.hoveredTurnIndex, 2);
  assert.equal(mockSurface.hoveredTurnAnchorY, 4);

  // Overlay card for left margin rail: card must start to the right of the rail (x = 4)
  const baseRows = new Array(10).fill(' '.repeat(80));
  const card = [
    '╭──────────╮',
    '│ Popover  │',
    '╰──────────╯'
  ];
  const overlaid = overlayTurnPreviewCard(baseRows, card, 4, 1, 80);
  assert.equal(overlaid.length, 10);
  // Row 4 should contain the card text
  assert.ok(overlaid[4]?.includes('Popover'));
  // Left 3 columns should be preserved
  assert.equal(overlaid[4]?.slice(0, 3), '   ');
});

test('buildTurnRailCells renders consecutive compact vertical pill track when count <= height', () => {
  const turns = Array.from({ length: 8 }, (_, idx) => ({
    turnIndex: idx + 1,
    totalTurns: 8,
    userPrompt: `Prompt ${idx + 1}`,
    assistantSummary: `Summary ${idx + 1}`,
    timestamp: 1000 + idx * 1000,
    formattedDate: '10:00 AM',
    frameId: idx + 1,
    startRow: idx * 10
  }));

  const result = buildTurnRailCells(turns, 35, 8, null);
  assert.equal(result.cells.length, 35);
  assert.equal(result.layout.dotRows.size, 8);

  // Consecutive vertical track centered or upper-aligned matching canonical design
  const startRow = Math.max(0, Math.floor((35 - 8) / 3));
  for (let i = 0; i < 8; i++) {
    const expectedRow = startRow + i;
    assert.equal(result.layout.dotRows.get(i + 1), expectedRow);
    assert.equal(result.layout.rowToTurn.get(expectedRow), i + 1);
  }
});

test('resolveActiveTurnIndex prioritizes latest turn when isAtBottom is true', () => {
  const mockTurns = [
    { turnIndex: 1, totalTurns: 8, userPrompt: 'turn 1', assistantSummary: '', timestamp: 1000, formattedDate: '10:00 AM', frameId: 1, startRow: 0 },
    { turnIndex: 7, totalTurns: 8, userPrompt: 'turn 7', assistantSummary: '', timestamp: 2000, formattedDate: '10:05 AM', frameId: 7, startRow: 120 },
    { turnIndex: 8, totalTurns: 8, userPrompt: 'turn 8', assistantSummary: '', timestamp: 3000, formattedDate: '10:10 AM', frameId: 8, startRow: 135 }
  ];

  // When viewport is at bottom, it must return turn 8 even if scrollTop is 122
  assert.equal(resolveActiveTurnIndex(mockTurns, 122, 20, true), 8);
  // When at top, returns turn 1
  assert.equal(resolveActiveTurnIndex(mockTurns, 0, 20, false), 1);
});

test('handleTurnRailMouse suppresses hover re-arming immediately following click and calls toBottom for latest turn', () => {
  let bottomCalled = false;
  let drawCalled = false;

  const mockSurface: any = {
    turnRailLayout: {
      railX: 1,
      stageTop: 0,
      viewportHeight: 30,
      dotRows: new Map([[1, 2], [2, 15], [3, 28]]),
      rowToTurn: new Map([[2, 1], [15, 2], [28, 3]]),
      turns: [
        { turnIndex: 1, totalTurns: 3, userPrompt: 'P1', assistantSummary: 'A1', timestamp: 1, formattedDate: '10:00', frameId: 1, startRow: 0 },
        { turnIndex: 2, totalTurns: 3, userPrompt: 'P2', assistantSummary: 'A2', timestamp: 2, formattedDate: '10:05', frameId: 2, startRow: 50 },
        { turnIndex: 3, totalTurns: 3, userPrompt: 'P3', assistantSummary: 'A3', timestamp: 3, formattedDate: '10:10', frameId: 3, startRow: 100 }
      ]
    },
    hoveredTurnIndex: 3,
    hoveredTurnAnchorY: 28,
    turnRailHoverSuppressed: false,
    viewport: {
      scrollTo: () => {},
      toBottom: () => { bottomCalled = true; }
    }
  };

  const mockHost = {
    scheduleDraw: () => {},
    draw: () => { drawCalled = true; }
  };

  // Click on dot 3 (the latest turn)
  const clickEvent = {
    mouse: { x: 1, y: 28, button: 0, pressed: true },
    sequence: '\x1b[<0;2;29M'
  };
  const clickResult = handleTurnRailMouse(clickEvent, mockSurface, mockHost);
  assert.equal(clickResult, true);
  assert.equal(bottomCalled, true, 'toBottom should be called when navigating to the latest turn');
  assert.equal(mockSurface.hoveredTurnIndex, null, 'hover card should be dismissed on click');
  assert.equal(mockSurface.turnRailHoverSuppressed, true, 'hover suppression should be active');

  // Immediately following mouse motion over the exact same dot should NOT resurrect hover
  const postClickMotionEvent = {
    mouse: { x: 1, y: 28, button: 0, pressed: false },
    sequence: '\x1b[<35;2;29M'
  };
  const motionResult = handleTurnRailMouse(postClickMotionEvent, mockSurface, mockHost);
  assert.equal(motionResult, true);
  assert.equal(mockSurface.hoveredTurnIndex, null, 'hover card must remain dismissed while suppressed');
});

test('overlayTurnPreviewCard clears underlying occluded text and prevents severed sentence tails from leaking past card border', () => {
  const baseRows = [
    '   • index.html (Core semantic layout, temporal HUD, 5 module viewports)               |',
    '   • style.css (Speculative Bio-Brutalist & Bioluminescent design system)              |',
    '   • biocanvas.js (60 FPS procedural canvas simulation engine)                         |',
    '   • audio.js (Web Audio API procedural sound synthesizer)                             |',
    '   • app.js (Chrono-reversal engine, gene compiler, organ models, and CLI terminal)    |',
    '   • test_suite.js (Automated verification suite)                                      |'
  ];

  const card = [
    '╭──────────────────────────────────────────────╮',
    '│ User Prompt Header Line 1                    │',
    '│ 1 of 3                              1:33 AM  │',
    '╰──────────────────────────────────────────────╯'
  ];

  const screenWidth = 85;
  const overlaid = overlayTurnPreviewCard(baseRows, card, 2, 1, screenWidth);
  assert.equal(overlaid.length, baseRows.length);

  for (let i = 0; i < card.length; i++) {
    const row = overlaid[i]!;
    const plain = stripAnsi(row);
    // Left 3 columns preserved for rail track
    assert.equal(plain.slice(0, 3), '   ');
    // Card content present
    assert.ok(plain.includes(stripAnsi(card[i]!)));
    // Crucial: Severed word tails from underlying lines must NOT leak directly after card
    assert.equal(plain.includes('temporal HUD'), false);
    assert.equal(plain.includes('Bioluminescent'), false);
    assert.equal(plain.includes('procedural canvas'), false);
    // Right margin scrollbar preserved
    assert.ok(plain.endsWith('|'));
  }
});

test('handleTurnRailMouse maintains hover tunnel when cursor moves into card body and supports clicking card', () => {
  let scrolledTo: number | null = null;
  const dotRows = new Map([[1, 2], [2, 5]]);
  const rowToTurn = new Map([[2, 1], [5, 2]]);
  const mockSurface: any = {
    turnRailLayout: {
      railX: 1,
      stageTop: 0,
      viewportHeight: 30,
      dotRows,
      rowToTurn,
      turns: [
        { turnIndex: 1, totalTurns: 2, userPrompt: 'Turn 1 prompt', assistantSummary: '', timestamp: 1, formattedDate: '1:00', frameId: 1, startRow: 0 },
        { turnIndex: 2, totalTurns: 2, userPrompt: 'Turn 2 prompt', assistantSummary: '', timestamp: 2, formattedDate: '2:00', frameId: 2, startRow: 42 }
      ],
      cardRect: { x: 4, y: 1, width: 52, height: 8, turnIndex: 1 }
    },
    hoveredTurnIndex: 1,
    hoveredTurnAnchorY: 2,
    viewport: {
      scrollTo: (row: number) => { scrolledTo = row; },
      toBottom: () => { scrolledTo = 999; }
    }
  };
  const mockHost = { scheduleDraw: () => {}, draw: () => {} };

  // 1. Mouse moves from dot 1 (col 1) into card body (col 20, row 4)
  const motionInsideCard = {
    mouse: { x: 20, y: 4, button: 0, pressed: false },
    sequence: '\x1b[<35;21;5M'
  };
  const handled = handleTurnRailMouse(motionInsideCard, mockSurface, mockHost);
  assert.equal(handled, true);
  // Hovered turn must NOT be dismissed when moving into the card body!
  assert.equal(mockSurface.hoveredTurnIndex, 1);

  // 2. Click inside the card body navigates to that turn
  const clickInsideCard = {
    mouse: { x: 20, y: 4, button: 0, pressed: true },
    sequence: '\x1b[<0;21;5M'
  };
  const clickHandled = handleTurnRailMouse(clickInsideCard, mockSurface, mockHost);
  assert.equal(clickHandled, true);
  assert.equal(scrolledTo, 0); // startRow of turn 1
  assert.equal(mockSurface.activeTurnIndex, 1);
  assert.equal(mockSurface.hoveredTurnIndex, null, 'card dismissed after click');
});




