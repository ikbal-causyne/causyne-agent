import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  messageAt, persistedMessageIndex, isMouseMotion, handleMessageMouse,
  handleMessageActionMenuMouse, openMessageActions, markHoveredMessage, MessageActionsLayer,
  type MessageMarker
} from '../src/tui/messageInteraction.js';
import { placeMessageActionPanel } from '../src/tui/messageActionPlacement.js';
import { StageSurface } from '../src/tui/stageSurface.js';
import {
  extractRowLinks, detectLinkAtPoint, openDetectedLink, resetLinkOpenDebounceForTests
} from '../src/tui/smartLinkClick.js';
import { registerStageConsoleGuard, setTransientNotice } from '../src/tui/consoleGuard.js';
import { mouseHoverTracking } from '../src/tui/mouseHover.js';
import { panelRows } from '../src/tui/overlay.js';
import { stripAnsi, truncate } from '../src/tui/text.js';
import { createSession, saveSessionMessages, getSession, deleteSession } from '../src/sessionStore.js';
import { MemoryManager } from '../src/memoryManager.js';
import { grantAlways, isAlwaysAllowed, revokeAllAlways } from '../src/approvalGrants.js';
import { memoryWrite } from '../src/tools/memoryWrite.js';

const markers: MessageMarker[] = [
  { id: 1, kind: 'user', row: 0, meta: { messageText: 'first' } },
  { id: 2, kind: 'assistant', row: 2, meta: { messageText: 'answer' } },
  { id: 3, kind: 'notice', row: 4 }
];

test('mouse hit testing follows padded viewport and excludes the composer', () => {
  const surface = {
    width: 100,
    out: { rows: 40 },
    stage: { height: 30, reserved: true },
    viewport: { height: 20, width: 97, scrollTop: 0 },
    transcript: { flatten: () => ({ rows: ['user', 'text', 'agent', 'text', 'notice'], markers }) }
  };
  // The band starts at row 10. Five transcript rows sit at its bottom.
  assert.equal(messageAt(surface, { x: 5, y: 24 }), null);
  assert.equal(messageAt(surface, { x: 5, y: 25 })?.id, 1);
  assert.equal(messageAt(surface, { x: 5, y: 27 })?.id, 2);
  assert.equal(messageAt(surface, { x: 5, y: 29 }), null);
  assert.equal(messageAt(surface, { x: 5, y: 31 }), null);
  assert.equal(messageAt(surface, { x: 99, y: 26 }), null);
});

test('left click opens message actions while a click outside does not', () => {
  const surface = {
    width: 100, out: { rows: 40 }, stage: { height: 30, reserved: true },
    viewport: { height: 20, width: 97, scrollTop: 0 },
    transcript: { flatten: () => ({ rows: ['user', 'text', 'agent', 'text', 'notice'], markers }) },
    hoveredMessageFrameId: null as number | null
  };
  let opened = 0;
  const host = {
    surface, busy: false, notice: '',
    openLayer() { opened++; }, scheduleDraw() {}
  };
  assert.equal(handleMessageMouse(host, {}, {
    mouse: { x: 4, y: 25, button: 0, pressed: true }, sequence: '\x1b[<0;5;26M'
  }), true);
  assert.equal(opened, 1);
  assert.equal(surface.hoveredMessageFrameId, 1);
  handleMessageMouse(host, {}, {
    mouse: { x: 4, y: 31, button: 0, pressed: true }, sequence: '\x1b[<0;5;32M'
  });
  assert.equal(opened, 1);
});

test('fork point is the persisted message, including intervening tool turns', () => {
  const messages = [
    { role: 'user', content: 'first' },
    { role: 'tool', content: 'output' },
    { role: 'assistant', content: 'answer' }
  ];
  assert.equal(persistedMessageIndex(markers[1]!, markers, messages as never), 2);
  assert.equal(persistedMessageIndex(markers[1]!, markers, [{ role: 'user', content: 'first' }] as never), null);
});

test('motion reports are separate from clicks', () => {
  assert.equal(isMouseMotion('\x1b[<32;10;5M'), true);
  assert.equal(isMouseMotion('\x1b[<0;10;5M'), false);
});

test('message actions fit exactly, are placed near the clicked row, and preserve left/right background text', () => {
  const layer = new MessageActionsLayer([
    { label: 'Copy message', description: 'to clipboard', value: 'copy' },
    { label: 'Fork from here', description: 'fresh permissions', value: 'fork' }
  ], () => {}, 24);
  const panel = panelRows(layer, 60, layer.preferredHeight());
  assert.equal(panel.length, 4);
  assert.match(panel[1]!, /Copy message/);
  assert.match(panel[2]!, /Fork from here/);
  const baseLine = 'LEFT_RAIL_TEXT_' + 'x'.repeat(60) + '_RIGHT_RAIL_END';
  const base = Array<string>(20).fill(baseLine);
  const placed = placeMessageActionPanel(base, panel, 90, 10, 24, 2);
  assert.equal(placed.layout?.y, 22);
  assert.equal(placed.layout?.count, 2);
  assert.match(placed.rows[14]!, /Fork from here/);
  // Verify left and right sides of the underlying row are preserved rather than erased
  assert.match(stripAnsi(placed.rows[14]!), /^LEFT_RAIL_TEXT_/);
  assert.match(stripAnsi(placed.rows[14]!), /_RIGHT_RAIL_END$/);
  assert.equal(base[13], baseLine);
  assert.equal(placeMessageActionPanel(base.slice(0, 2), panel, 90, 10, 24, 2).layout, null);
});

test('truncate and placeMessageActionPanel close open OSC 8 hyperlinks so link hover never tears across modal rows', () => {
  const osc8Row = '    \x1b]8;;file:///workspace/suika-game/physics.js\x1b\\physics.js\x1b]8;;\x1b\\): slack variables';
  // Cut at column 11 ("    physics") right in the middle of the OSC 8 hyperlink
  const cut = truncate(osc8Row, 11, '');
  assert.equal(stripAnsi(cut), '    physics');
  assert.equal(
    cut.includes('\x1b]8;;\x1b\\'),
    true,
    'truncate must close open ST-terminated OSC 8 hyperlink when slicing mid-link'
  );

  // Also verify BEL-terminated OSC 8 hyperlinks are closed cleanly
  const belOsc8Row = '    \x1b]8;;https://example.com\x07example.com\x1b]8;;\x07 tail';
  const belCut = truncate(belOsc8Row, 11, '');
  assert.equal(belCut.includes('\x1b]8;;\x07'), true);

  // Place MessageActionsLayer over a row containing an OSC 8 link at the left splice boundary
  const layer = new MessageActionsLayer([
    { label: 'Copy message', description: 'to clipboard', value: 'copy' },
    { label: 'Fork from here', description: 'create a new session · fresh permissions', value: 'fork' },
    { label: 'Revert to here', description: 'undo messages and file changes', value: 'revert' }
  ], () => {}, 5);
  const panel = panelRows(layer, 60, layer.preferredHeight());
  const base = Array<string>(12).fill(osc8Row + ' '.repeat(60));
  const placed = placeMessageActionPanel(base, panel, 90, 0, 5, 3);
  const topOverlayRow = placed.rows[placed.layout!.y]!;
  const beforeModal = topOverlayRow.slice(0, topOverlayRow.indexOf('╭'));
  const opensBeforeModal = (beforeModal.match(/\x1b\]8;;[^\x07\x1b]+(?:\x07|\x1b\\)/g) || []).length;
  const closesBeforeModal = (beforeModal.match(/\x1b\]8;;(?:\x07|\x1b\\)/g) || []).length;
  assert.equal(
    opensBeforeModal,
    closesBeforeModal,
    'Every OSC 8 hyperlink opened before the modal border must be closed before the modal border begins'
  );
});

test('markHoveredMessage skips leading/trailing blank rows and avoids duplicate arrows', () => {
  const frameRows = [
    '',
    '  ▸ Causyne',
    '  Hello world',
    ''
  ];
  const frameMarkers: MessageMarker[] = [
    { id: 10, kind: 'assistant', row: 0, meta: { messageText: 'Hello world' } }
  ];
  const surface = {
    width: 80,
    out: { rows: 20 },
    stage: { height: 10, reserved: false },
    viewport: { height: 4, width: 80, scrollTop: 0 },
    transcript: { flatten: () => ({ rows: frameRows, markers: frameMarkers }) },
    hoveredMessageFrameId: 10
  };
  const rows = frameRows.slice();
  markHoveredMessage(rows, surface, 80);
  // Blank spacing rows at index 0 and 3 must stay untouched
  assert.equal(rows[0], '');
  assert.equal(rows[3], '');
  // Row 1 already has '▸ Causyne', so it must not get a second '▸' prepended
  assert.equal((stripAnsi(rows[1]!).match(/▸/g) || []).length, 1);
});

test('hover tracking is disabled by default for terminal text selection and opt-in with CAUSYNE_MOUSE_HOVER=1', () => {
  assert.equal(mouseHoverTracking(true, {}), '');
  assert.equal(mouseHoverTracking(true, { CAUSYNE_MOUSE_HOVER: '1' }), '\x1b[?1003h');
  assert.equal(mouseHoverTracking(false, { CAUSYNE_MOUSE_HOVER: '1' }), '\x1b[?1003l');
  assert.equal(mouseHoverTracking(true, { CAUSYNE_MOUSE_HOVER: '0' }), '');
});

test('message action menu selects the clicked row and closes on outside clicks or typing', () => {
  let selected = -1;
  let activated = 0;
  const layer = {
    messageActions: true,
    actionLayout: { x: 8, y: 12, width: 60, count: 2 },
    list: { moveTo(index: number) { selected = index; } },
    key({ name }: { name: string }) { if (name === 'enter') activated++; return 'close'; }
  };
  assert.equal(handleMessageActionMenuMouse(layer, {
    mouse: { x: 10, y: 14, button: 0, pressed: true }, sequence: '\x1b[<0;11;15M'
  }), 'close');
  assert.equal(selected, 1);
  assert.equal(activated, 1);
  assert.equal(handleMessageActionMenuMouse(layer, {
    mouse: { x: 70, y: 14, button: 0, pressed: true }, sequence: '\x1b[<0;71;15M'
  }), 'close');
  assert.equal(activated, 1);

  // Verify MessageActionsLayer dismisses on typing so user can immediately type in prompt
  const menu = new MessageActionsLayer([{ label: 'Option 1', description: 'test', value: '1' }], () => {});
  assert.equal(menu.key({ name: 'a' }), 'dismiss');
  assert.equal(menu.key({ name: 'space' }), 'dismiss');
  assert.equal(menu.key({ name: 'backspace' }), 'dismiss');
  assert.equal(menu.key({ name: 'escape' }), 'close');
});

test('forking a clicked message presents Copy/Fork/Revert, copies only prior turns, names fork (#1), and resets grants', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-message-fork-'));
  let forkId: string | null = null;
  let sourceId: string | null = null;
  try {
    const source = createSession(workspace, 'Test conversation', true);
    sourceId = source.id;
    saveSessionMessages(source.id, [
      { role: 'user', content: 'first' },
      { role: 'tool', content: 'result' },
      { role: 'assistant', content: 'answer' },
      { role: 'user', content: 'later' }
    ]);
    const memory = new MemoryManager(workspace, source.id);
    const loop = {
      memoryManager: memory,
      messages: [] as Array<{ role: string; content?: unknown }>,
      resetApprovalScope() { this.reset = true; },
      reset: false,
      tokenTracker: { reset() {} }
    };
    let layer: any = null;
    let rendered: any[] = [];
    const host = {
      busy: false, notice: '',
      surface: {
        width: 100, out: { rows: 40 }, stage: { height: 30, reserved: true },
        viewport: { height: 20, width: 100, scrollTop: 0, toBottom() {} },
        transcript: { flatten: () => ({ rows: ['first', 'answer'], markers: markers.slice(0, 2) }) }
      },
      renderer: { renderSessionHistory(history: any[]) { rendered = history; } },
      openLayer(next: unknown) { layer = next; }, scheduleDraw() {}
    };
    grantAlways('fs_write');
    openMessageActions(host, loop, markers[1]!);
    assert.ok(layer?.messageActions);
    assert.equal(layer.list.filtered.length, 3);
    assert.deepEqual(layer.list.filtered.map((i: any) => i.value), ['copy', 'fork', 'revert']);
    layer.list.moveTo(1, 3);
    assert.equal(layer.key({ name: 'enter' }), 'close');
    forkId = memory.sessionId;
    assert.notEqual(forkId, source.id);
    assert.match(getSession(forkId)?.title || '', /Test conversation \(fork #1\)/);
    assert.deepEqual(getSession(forkId)?.messages.map(message => message.role), ['user', 'tool', 'assistant']);
    assert.equal(getSession(source.id)?.messages.length, 4);
    assert.equal(rendered.length, 3);
    assert.equal(isAlwaysAllowed('fs_write'), false);
    assert.equal(loop.reset, true);
  } finally {
    revokeAllAlways();
    if (forkId) deleteSession(forkId);
    if (sourceId) deleteSession(sourceId);
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('forking and reverting work during an active turn with in-memory loop.messages', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-busy-fork-revert-'));
  let sourceId: string | null = null;
  let forkId: string | null = null;
  try {
    const source = createSession(workspace, 'In-flight Session', true);
    sourceId = source.id;
    const memory = new MemoryManager(workspace, source.id);
    let interrupted = 0;
    const loop = {
      memoryManager: memory,
      // Simulate an active turn where loop.messages has the user prompt before turn completion
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'answer' }
      ],
      abort() { interrupted++; },
      resetApprovalScope() {},
      tokenTracker: { reset() {} }
    };
    let layer: any = null;
    let composerRestored = '';
    const host = {
      busy: true,
      notice: '',
      interrupt() { interrupted++; this.busy = false; },
      setText(val: string) { composerRestored = val; },
      surface: {
        width: 100, out: { rows: 40 }, stage: { height: 30, reserved: true },
        viewport: { height: 20, width: 100, scrollTop: 0, toBottom() {} },
        transcript: { flatten: () => ({ rows: ['first', 'answer'], markers: markers.slice(0, 2) }) }
      },
      renderer: { renderSessionHistory() {}, setSessionInfo() {} },
      openLayer(next: unknown) { layer = next; },
      scheduleDraw() {}
    };

    // Even while busy=true and before saveSessionMessages was called manually, Fork & Revert appear
    openMessageActions(host, loop, markers[0]!);
    assert.equal(layer.list.filtered.length, 3);
    // Select Revert (index 2) on user message 'first'
    layer.list.moveTo(2);
    assert.equal(layer.key({ name: 'enter' }), 'close');
    assert.ok(interrupted >= 1);
    assert.equal(composerRestored, 'first');
    assert.equal(loop.messages.length, 0);
  } finally {
    if (forkId) deleteSession(forkId);
    if (sourceId) deleteSession(sourceId);
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('smart link detection extracts OSC 8 links, recovers truncated URLs, and ignores code filenames', () => {
  const fullInspectUrl = 'https://vercel.com/ikbals-projects-ab6da137/suika-game/Aph3W57X2wU7gG6q1rK7p8nL9vB2';
  const rawMessageText = [
    'Live Production URL: https://suika-game-lyart.vercel.app',
    `Inspect URL: ${fullInspectUrl}`,
    'Modified files: index.html, style.css, fruit.js, physics_tables.json'
  ].join('\n');

  // 1. OSC 8 hyperlink
  const osc8Row = '  • Live URL: \x1b]8;;https://suika-game-lyart.vercel.app\x07suika-game-lyart.vercel.app\x1b]8;;\x07';
  const osc8Links = extractRowLinks(osc8Row, 0, rawMessageText);
  assert.equal(osc8Links.length, 1);
  assert.equal(osc8Links[0]!.url, 'https://suika-game-lyart.vercel.app');
  assert.equal(osc8Links[0]!.startCol, 14);
  assert.equal(osc8Links[0]!.endCol, 40);

  // 2. Truncated inspect URL recovers full URL from rawMessageText
  const truncatedRow = '  • Inspect: vercel.com/ikbals-projects-ab6da137/suika-game/…';
  const truncLinks = extractRowLinks(truncatedRow, 1, rawMessageText);
  assert.equal(truncLinks.length, 1);
  assert.equal(truncLinks[0]!.url, fullInspectUrl);

  // 3. Code filenames are NOT falsely detected as web links
  const codeRow = '  • Files: index.html, style.css, fruit.js, physics_tables.json';
  const codeLinks = extractRowLinks(codeRow, 2, rawMessageText);
  assert.equal(codeLinks.length, 0);
});

test('clicking a link in a message opens the URL instead of popping up Message Actions', () => {
  resetLinkOpenDebounceForTests();
  const rowWithLink = '  Live: https://suika-game-lyart.vercel.app/ ready';
  const linkMarker: MessageMarker = {
    id: 5,
    kind: 'assistant',
    row: 0,
    meta: { messageText: 'Live: https://suika-game-lyart.vercel.app/ ready' }
  };
  const surface = {
    width: 100,
    out: { rows: 20 },
    stage: { height: 10, reserved: true },
    viewport: { height: 5, width: 97, scrollTop: 0 },
    transcript: { flatten: () => ({ rows: [rowWithLink], markers: [linkMarker] }) },
    hoveredMessageFrameId: null as number | null
  };
  // Single transcript row sits at bottom of 5-row viewport (viewRow = 4, stageTop = 10 -> y = 14)
  const detected = detectLinkAtPoint(surface, { x: 15, y: 14 }, linkMarker);
  assert.ok(detected);
  assert.equal(detected?.url, 'https://suika-game-lyart.vercel.app/');

  const spawned: Array<{ cmd: string; args: string[] }> = [];
  assert.equal(
    openDetectedLink('https://suika-game-lyart.vercel.app/', {
      platform: 'darwin',
      now: 1000,
      spawnImpl: ((cmd: string, args: string[]) => {
        spawned.push({ cmd, args });
        return { on() {}, unref() {} };
      }) as never
    }),
    true
  );
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0]!.cmd, 'open');
  assert.deepEqual(spawned[0]!.args, ['https://suika-game-lyart.vercel.app/']);

  // Clicking on the link via handleMessageMouse must NOT open the MessageActions modal
  let layerOpened = 0;
  const host = {
    surface,
    busy: false,
    notice: '',
    openLayer() { layerOpened++; },
    scheduleDraw() {}
  };
  handleMessageMouse(host, {}, {
    mouse: { x: 15, y: 14, button: 0, pressed: true },
    sequence: '\x1b[<0;16;15M'
  });
  assert.equal(layerOpened, 0);
  assert.match(host.notice, /Opened https:\/\/suika-game-lyart\.vercel\.app\//);
  setTransientNotice(host, '', 0);
});

test('memoryWrite never writes Cortex failure stack/errors to console.error and stage console guard blocks raw writes', async () => {
  let errorCalled = 0;
  const origError = console.error;
  try {
    const unregister = registerStageConsoleGuard({
      out: process.stdout,
      stage: { reserved: true }
    });
    // Even if a component calls console.error while the stage is reserved, it is suppressed
    console.error('SHOULD_BE_SUPPRESSED');
    unregister();

    console.error = () => { errorCalled++; };
    const res = await memoryWrite.execute({
      fact: 'Test fact for TUI composer integrity',
      creativePattern: {
        project: 'suika-game',
        designApproach: 'Playful tactile arcade',
        colorPalette: 'warm cream',
        fonts: 'Fredoka'
      }
    });
    assert.equal(res.success, true);
    assert.equal(errorCalled, 0);
  } finally {
    console.error = origError;
  }
});

test('placeMessageActionPanel adaptively floats upward when clicking bottom message and dims backdrop', () => {
  const layer = new MessageActionsLayer([
    { label: 'Copy message', description: 'to clipboard', value: 'copy' },
    { label: 'Fork from here', description: 'fresh session', value: 'fork' },
    { label: 'Revert to here', description: 'undo changes', value: 'revert' }
  ], () => {}, 19);

  // Preferred width adapts to items and terminal width
  const adaptWidth = layer.preferredWidth(80);
  assert.ok(adaptWidth >= 40 && adaptWidth <= 65);

  const panel = panelRows(layer, adaptWidth, layer.preferredHeight());
  assert.equal(panel.length, 5);

  // Viewport of 20 rows, message is located at the very bottom: rows 17..19
  const base = Array<string>(20).fill('Some message content line in viewport');
  const placedBottom = placeMessageActionPanel(base, panel, 80, 0, 19, 3, {
    messageBounds: { startRow: 17, endRow: 19 },
    dimBackdrop: true
  });

  // Must NOT stick to the bottom row (15); must float upward into the clear reading area
  assert.ok(placedBottom.layout !== null);
  assert.ok(
    placedBottom.layout.y < 15,
    `Panel at bottom message should float upward away from bottom edge (got y=${placedBottom.layout.y}, expected < 15)`
  );
  assert.ok(placedBottom.layout.y >= 1);

  // Background rows above and below panel should have dim styling applied
  const rowAbove = placedBottom.rows[0]!;
  assert.match(rowAbove, /\x1b\[2m/);

  // Left and right sides of spliced row should also be dimmed
  const splicedRow = placedBottom.rows[placedBottom.layout.y]!;
  assert.match(splicedRow, /\x1b\[2m/);
});

test('markerAt honors surface.env sidebar disablement on wide terminals and markHoveredMessage guards non-finite scrollTop', () => {
  const wideSurface: any = {
    width: 200,
    env: { CAUSYNE_SIDEBAR: 'off' },
    out: { rows: 30 },
    stage: { height: 20, reserved: true },
    viewport: { height: 15, width: 200, scrollTop: Number.NaN },
    hoveredMessageFrameId: 1,
    transcript: {
      flatten: () => ({
        rows: ['   ┃ User line across wide screen'],
        markers: [{ id: 1, kind: 'user', row: 0, meta: { messageText: 'User line across wide screen' } }]
      })
    }
  };

  // At x = 175 on a 200-column terminal with CAUSYNE_SIDEBAR=off, the click is in the main column, not a sidebar
  const hit = messageAt(wideSurface, { x: 175, y: 24 });
  assert.equal(hit?.id, 1);

  const viewportRows = Array<string>(14).fill('').concat(['   ┃ User line across wide screen']);
  markHoveredMessage(viewportRows, wideSurface, 200);
  assert.ok(viewportRows[14]!.length > '   ┃ User line across wide screen'.length);
});

test('placeMessageActionPanel normalizes inverted messageBounds and re-applies dim after SGR 22m or short reset', () => {
  const layer = new MessageActionsLayer([
    { label: 'Copy message', description: 'to clipboard', value: 'copy' }
  ], () => {}, 18);
  const panel = panelRows(layer, 44, layer.preferredHeight());
  const base = Array<string>(20).fill('Prefix \x1b[1mBold\x1b[22m Normal \x1b[m Tail');

  // Inverted bounds (e.g. nextM.row - 1 < marker.row on an empty/collapsed frame at bottom row 18)
  const placed = placeMessageActionPanel(base, panel, 80, 0, 18, 1, {
    messageBounds: { startRow: 18, endRow: 17 },
    dimBackdrop: true
  });

  assert.ok(placed.layout !== null);
  assert.ok(placed.layout.y < 15, `Expected bottom inverted-bound message to float upward (< 15), got y=${placed.layout.y}`);
  assert.match(placed.rows[0]!, /\x1b\[22m\x1b\[2m Normal \x1b\[m\x1b\[2m Tail/);
});

test('extractRowLinks preserves back-to-back OSC 8 links and detectLinkAtPoint honors surface.env sidebar disablement', () => {
  const row = '\x1b]8;;https://first.example.com\x07First\x1b]8;;https://second.example.com\x07Second\x1b]8;;\x07';
  const links = extractRowLinks(row, 0);
  assert.equal(links.length, 2, 'Both back-to-back OSC 8 links must be preserved');
  assert.equal(links[0]?.url, 'https://first.example.com');
  assert.equal(links[1]?.url, 'https://second.example.com');

  const wideLinkRow = `${' '.repeat(170)}\x1b]8;;https://causyne.com/docs\x07docs\x1b]8;;\x07`;
  const wideSurface: any = {
    width: 200,
    env: { CAUSYNE_SIDEBAR: 'off' },
    out: { rows: 25 },
    stage: { height: 20, reserved: true },
    viewport: { viewHeight: 15, viewWidth: 200, scrollTop: 0 },
    transcript: {
      flatten: () => ({
        rows: [wideLinkRow],
        markers: [{ id: 1, kind: 'assistant', row: 0, meta: { messageText: 'https://causyne.com/docs' } }]
      })
    }
  };
  const detected = detectLinkAtPoint(wideSurface, { x: 171, y: 19 });
  assert.equal(detected?.url, 'https://causyne.com/docs');
});

test('StageSurface keeps actionLayout.y and turnRail stageTop non-negative and rail intact on narrow or shrinking viewports', () => {
  const writes: string[] = [];
  const out = {
    columns: 60,
    rows: 20,
    isTTY: true,
    write(chunk: string) { writes.push(String(chunk)); return true; },
    on() {},
    removeListener() {}
  };
  const surface = new StageSurface({ out, env: { TERM: 'xterm', CAUSYNE_SIDEBAR: 'off', CAUSYNE_RAIL: '1' } });
  surface.open();
  surface.transcript.append({
    kind: 'user',
    produce: () => Array.from({ length: 8 }, (_, i) => `   ┃ user line ${i}`),
    meta: { messageText: 'hello world' }
  });
  surface.transcript.append({
    kind: 'assistant',
    produce: () => Array.from({ length: 8 }, (_, i) => `   reply line ${i}`),
    meta: { messageText: 'reply line' }
  });
  surface.hoveredTurnIndex = 1;
  surface.present(['> '], { row: 0, col: 2 });

  const rect = surface.turnRailLayout?.cardRect;
  assert.ok(rect !== null && rect !== undefined, 'cardRect should be computed');
  assert.equal(rect.x, 3, 'turn preview card should stay flush at railX + 2');
  assert.ok(rect.x + rect.width <= 60, `cardRect right edge (${rect.x + rect.width}) must fit within 60 cols`);

  surface.hoveredTurnIndex = null;
  out.rows = 8; // transient shrink below current stage.height
  const layer = new MessageActionsLayer([
    { label: 'Copy message', description: 'to clipboard', value: 'copy' },
    { label: 'Fork from here', description: 'fresh', value: 'fork' }
  ], () => {}, 4);
  const panel = panelRows(layer, 36, layer.preferredHeight());
  surface.presentMessageActions(panel, layer);
  assert.ok(layer.actionLayout !== null);
  assert.ok(layer.actionLayout.y >= 0, `actionLayout.y must not be negative during transient shrink, got ${layer.actionLayout.y}`);
  assert.ok((surface.turnRailLayout?.stageTop ?? 0) >= 0, 'turnRailLayout.stageTop must not be negative');
});



