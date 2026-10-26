import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ChatRenderer } from '../src/tui/chatRenderer.js';
import { StageSurface } from '../src/tui/stageSurface.js';
import { Transcript } from '../src/tui/transcript.js';
import { visibleWidth, stripAnsi } from '../src/tui/text.js';
import { chatTextWidth } from '../src/tui/textLayout.js';

const narrow = 109; // Conversation width at 155 terminal columns with sidebar and rail.
const wide = 188; // Conversation width at 234 terminal columns with sidebar and rail.

test('error text reflows at both screenshot widths without losing its final words', () => {
  const transcript = new Transcript();
  const renderer = new ChatRenderer({ transcript });
  const message = 'ACP Peer Agent (cursor) Error: session/new failed: Authentication required. Make sure "cursor-agent" is installed and running. Verify the provider session and reconnect before trying again.';
  renderer.handle({ type: 'error', message });

  const narrowRows = transcript.rows(narrow).map(stripAnsi);
  const wideRows = transcript.rows(wide).map(stripAnsi);
  assert.ok(narrowRows.join(' ').replace(/\s+/g, ' ').includes('reconnect before trying again.'));
  assert.ok(wideRows.join(' ').replace(/\s+/g, ' ').includes('reconnect before trying again.'));
  assert.ok(narrowRows.length > wideRows.length, 'the message should use more rows when the window narrows');
  assert.ok(transcript.rows(narrow).every((row: string) => visibleWidth(row) < narrow));
  assert.ok(transcript.rows(wide).every((row: string) => visibleWidth(row) < wide));
});

test('tool failure detail and assistant prose use the resized conversation width', () => {
  const transcript = new Transcript();
  const renderer = new ChatRenderer({ transcript });
  const detail = 'Authentication required. Make sure "cursor-agent" is installed and running. Reconnect the account and confirm the local peer can create a session.';
  renderer.handle({ type: 'step_complete', result: { success: false, error: detail } });
  renderer.handle({ type: 'agent_message', content: 'This paragraph should occupy the available conversation column when the terminal becomes wider, while retaining every word when the terminal shrinks again. '.repeat(4) });

  const narrowRows = transcript.rows(narrow).map(stripAnsi);
  const wideRows = transcript.rows(wide).map(stripAnsi);
  assert.ok(narrowRows.join(' ').includes('local peer can create a session.'));
  assert.ok(wideRows.join(' ').includes('local peer can create a session.'));
  assert.ok(narrowRows.length > wideRows.length);
  assert.equal(chatTextWidth(wide), wide - 4);
  assert.ok(transcript.rows(wide).every((row: string) => visibleWidth(row) < wide));
});

test('the complete error remains above the input through a 155x78 to 234x76 resize', () => {
  const out = { columns: 155, rows: 78, isTTY: true, write: () => true, on() {}, removeListener() {} };
  const surface = new StageSurface({ out, env: { CAUSYNE_MOUSE: '0' } });
  assert.equal(surface.open(), true);
  try {
    surface.enterHome({ cwd: '/tmp/work', provider: 'acp/cursor', model: 'cursor' });
    surface.present(['INPUT'], { row: 0, col: 0 });
    surface.leaveHome(true);
    const renderer = new ChatRenderer({ transcript: surface.transcript });
    renderer.handle({ type: 'error', message: 'Authentication required. Make sure the peer is installed and running.\n\nStopped after 3 attempts. Nothing changed between them, so retrying further would only spend your budget.' });

    for (const [columns, rows] of [[155, 78], [234, 76]] as const) {
      out.columns = columns;
      out.rows = rows;
      assert.equal(surface.resize(), true);
      surface.present(['INPUT'], { row: 0, col: 0 });
      const main = surface.stage.prev.map((row: string) => stripAnsi(row).slice(0, columns - 43));
      assert.ok(main.join(' ').replace(/\s+/g, ' ').includes('would only spend your budget.'));
      assert.match(main.at(-1) || '', /INPUT/);
      assert.equal(surface.stage.height, rows - 1);
      assert.ok(surface.stage.prev.every((row: string) => visibleWidth(row) < columns));
    }
  } finally {
    surface.close();
  }
});
