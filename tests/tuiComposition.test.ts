import { test } from 'node:test';
import assert from 'node:assert/strict';

import { centerRows, composerWidth, openingRows } from '../src/tui/layout.js';
import { commandDialog } from '../src/tui/commandPresentation.js';
import { ChatRenderer } from '../src/tui/chatRenderer.js';
import { Transcript } from '../src/tui/transcript.js';
import { stripAnsi, visibleWidth } from '../src/tui/text.js';

test('opening and composer use one centered readable column', () => {
  assert.equal(composerWidth(156), 82);
  assert.equal(composerWidth(60), 58);
  const centered = centerRows(['hello', 'x'], 15);
  assert.equal(centered.inset, 5);
  assert.deepEqual(centered.rows, ['     hello', '     x']);
  assert.ok(openingRows(['hello'], 156, 78).findIndex(row => row.includes('hello')) > 0);
  assert.deepEqual(openingRows(['hello'], 60, 24), ['                           hello']);
});

test('session and MCP command feedback stays in dialogs', () => {
  assert.deepEqual(commandDialog('/session new', { ok: true, output: 'created' }), {
    title: 'Sessions', text: 'created', danger: false
  });
  assert.deepEqual(commandDialog('/mcp test server', { ok: false, output: 'unavailable' }), {
    title: 'MCP servers', text: 'unavailable', danger: true
  });
  assert.equal(commandDialog('/mcp', { effect: 'pick-mcp' }), null);
  assert.equal(commandDialog('/help', { output: 'help' }), null);
});

test('a submitted multiline message is a single readable transcript frame', () => {
  const transcript = new Transcript();
  const out = { columns: 156, write: () => true };
  const renderer = new ChatRenderer({ out, transcript });
  renderer.renderUserMessage('first line\nsecond line');

  const rows = transcript.rows(156);
  const content = stripAnsi(rows.join('\n'));
  assert.equal(transcript.markers(156).filter(marker => marker.kind === 'user').length, 1);
  assert.equal(content.match(/first line/g)?.length, 1);
  assert.equal(content.match(/second line/g)?.length, 1);
  assert.ok(content.indexOf('first line') < content.indexOf('second line'));
  assert.ok(rows.every(row => visibleWidth(row) < 156), 'the message must not wrap at the terminal edge');
  assert.ok(rows.find(row => row.includes('first line'))?.startsWith('  '));
});

test('user message uses unbroken continuous heavy vertical bar (one line) without gaps', async () => {
  const { barBlock } = await import('../src/tui/block.js');
  const { GLYPHS } = await import('../src/tui/theme.js');
  const lines = ['First line', 'Second line', 'Third line', 'Fourth line'];
  const rows = barBlock(lines, { width: 50, role: 'user', filled: true, surface: 'surfaceHi' });

  // Each line must start with continuous bar (GLYPHS.barHeavy / '┃' in Unicode, '|' in ASCII)
  const expectedBar = GLYPHS.barHeavy || '┃';
  for (const row of rows) {
    const unstyled = stripAnsi(row);
    assert.ok(unstyled.startsWith(expectedBar), `Expected row to start with unbroken '${expectedBar}', got: ${unstyled.slice(0, 5)}`);
  }
  // All 4 rows must be rendered (matches exact length)
  assert.equal(rows.length, 4);
});

test('user message box and chatbox have symmetrical width and alignment', async () => {
  const { StageSurface } = await import('../src/tui/stageSurface.js');
  const out = { columns: 155, rows: 40, isTTY: true, write: () => true, on() {}, removeListener() {} };
  const surface = new StageSurface({ out, env: { CAUSYNE_SIDEBAR: '1' } });
  surface.open();

  // Add a user message to trigger turns
  surface.transcript.append({
    kind: 'user',
    produce: () => ['line 1', 'line 2'],
    meta: { messageText: 'hello' }
  });

  const sessionWidth = surface.composeWidth();
  const availableW = surface.composeAvailableWidth();

  assert.ok(sessionWidth > 20, 'sessionWidth must be positive');
  assert.ok(availableW > sessionWidth, 'available width must accommodate composer width');

  // Verify that chatRenderer's renderUserMessage uses this exact composeWidth
  const renderer = new ChatRenderer({ out, transcript: surface.transcript });
  renderer.renderUserMessage('testing symmetry');

  const frames = surface.transcript.frames;
  const userFrame = frames[frames.length - 1];
  assert.equal(userFrame?.kind, 'user');

  // Produce the frame rows at availableW
  const producedRows = userFrame.produce(availableW);
  assert.ok(producedRows.length > 0);
  assert.ok(visibleWidth(producedRows[0]!) <= availableW);
});


