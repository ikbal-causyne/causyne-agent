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
