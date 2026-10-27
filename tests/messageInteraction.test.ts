import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  messageAt, persistedMessageIndex, isMouseMotion, handleMessageMouse,
  handleMessageActionMenuMouse, openMessageActions, MessageActionsLayer,
  type MessageMarker
} from '../src/tui/messageInteraction.js';
import { placeMessageActionPanel } from '../src/tui/messageActionPlacement.js';
import { mouseHoverTracking } from '../src/tui/mouseHover.js';
import { panelRows } from '../src/tui/overlay.js';
import { createSession, saveSessionMessages, getSession, deleteSession } from '../src/sessionStore.js';
import { MemoryManager } from '../src/memoryManager.js';
import { grantAlways, isAlwaysAllowed, revokeAllAlways } from '../src/approvalGrants.js';

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

test('message actions fit exactly and are placed near the clicked row', () => {
  const layer = new MessageActionsLayer([
    { label: 'Copy message', description: 'to clipboard', value: 'copy' },
    { label: 'Fork from here', description: 'fresh permissions', value: 'fork' }
  ], () => {}, 24);
  const panel = panelRows(layer, 60, layer.preferredHeight());
  assert.equal(panel.length, 4);
  assert.match(panel[1]!, /Copy message/);
  assert.match(panel[2]!, /Fork from here/);
  const base = Array<string>(20).fill('conversation');
  const placed = placeMessageActionPanel(base, panel, 90, 10, 24, 2);
  assert.equal(placed.layout?.y, 22);
  assert.equal(placed.layout?.count, 2);
  assert.match(placed.rows[14]!, /Fork from here/);
  assert.equal(base[13], 'conversation');
  assert.equal(placeMessageActionPanel(base.slice(0, 2), panel, 90, 10, 24, 2).layout, null);
});

test('hover tracking is disabled by default for terminal text selection and opt-in with CAUSYNE_MOUSE_HOVER=1', () => {
  assert.equal(mouseHoverTracking(true, {}), '');
  assert.equal(mouseHoverTracking(true, { CAUSYNE_MOUSE_HOVER: '1' }), '\x1b[?1003h');
  assert.equal(mouseHoverTracking(false, { CAUSYNE_MOUSE_HOVER: '1' }), '\x1b[?1003l');
  assert.equal(mouseHoverTracking(true, { CAUSYNE_MOUSE_HOVER: '0' }), '');
});

test('message action menu selects the clicked row and keeps clicks outside inert', () => {
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
  }), 'handled');
  assert.equal(activated, 1);
});

test('forking a clicked message copies only prior turns and resets grants', () => {
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
    assert.equal(layer.list.filtered.length, 2);
    layer.list.moveTo(1, 2);
    assert.equal(layer.key({ name: 'enter' }), 'close');
    forkId = memory.sessionId;
    assert.notEqual(forkId, source.id);
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
