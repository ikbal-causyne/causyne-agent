import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityRows } from '../src/tui/activityLayout.js';
import { ChatRenderer } from '../src/tui/chatRenderer.js';
import { StageSurface } from '../src/tui/stageSurface.js';
import { Transcript } from '../src/tui/transcript.js';
import { stripAnsi, visibleWidth } from '../src/tui/text.js';

const command = 'Antigravity run_command cd ~/tesla-roadster-landing/assets && for id in PE4EWu67RQw j8lbY_D7xcY; do curl -s "https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=$id&format=json" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d[\'title\'])"; done';

test('activity keeps long and multiline provider actions inside the conversation column', () => {
  const message = `${command}\n  ~/tesla-roadster-landing/assets/photo-interior.jpg\n${command}`;
  for (const width of [60, 109, 188]) {
    const rows = activityRows(message, width);
    assert.ok(rows.length > 3);
    assert.ok(rows.every(row => visibleWidth(row) < width), `activity exceeded ${width} columns`);
    assert.ok(rows[0]?.startsWith('▸ '));
    assert.ok(rows.slice(1).every(row => row.startsWith('  ')), 'continuations retain the activity inset');
    const unwrapped = rows.join('').replace(/\s+/g, '');
    assert.match(unwrapped, /photo-interior\.jpg/);
    assert.match(unwrapped, /format=json/);
  }
});

test('activity frame reflows on resize without losing the command tail', () => {
  const transcript = new Transcript();
  const renderer = new ChatRenderer({ transcript });
  renderer.handle({ type: 'agent_activity', activity: command });
  const narrow = transcript.rows(109).map(stripAnsi);
  const wide = transcript.rows(188).map(stripAnsi);
  assert.ok(narrow.length > wide.length);
  for (const [rows, width] of [[narrow, 109], [wide, 188]] as const) {
    assert.ok(rows.every(row => visibleWidth(row) < width));
    assert.match(rows.join(' '), /; done$/);
  }
});

test('a long activity stays inside the conversation column beside the sidebar', () => {
  const out = { columns: 155, rows: 78, isTTY: true, write: () => true, on() {}, removeListener() {} };
  const surface = new StageSurface({ out, env: { CAUSYNE_MOUSE: '0' } });
  assert.equal(surface.open(), true);
  try {
    surface.enterHome({ cwd: '/tmp/work', provider: 'test', model: 'test' });
    surface.leaveHome(true);
    const renderer = new ChatRenderer({ transcript: surface.transcript });
    renderer.handle({ type: 'agent_activity', activity: command });
    surface.present(['INPUT'], { row: 0, col: 0 });
    const rows = surface.stage.prev.map(stripAnsi);
    assert.ok(rows.every(row => visibleWidth(row) < out.columns));
    assert.match(rows.join(' '), /; done/);
  } finally {
    surface.close();
  }
});
