import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Stage } from '../src/tui/stage.js';
import { StageSurface } from '../src/tui/stageSurface.js';
import { settleStageResize } from '../src/tui/resizeRecovery.js';
import { sessionSidebarRows } from '../src/tui/sessionSidebar.js';
import { stripAnsi, visibleWidth } from '../src/tui/text.js';

test('tiny terminal widths constrain physical writes and the editing caret', () => {
  const out = { columns: 80, rows: 30, write: (_text: string) => true };
  const stage = new Stage({ out, env: {} });
  stage.reserve();
  for (const columns of [80, 19, 8, 2, 1, 80]) {
    out.columns = columns;
    stage.invalidate();
    stage.paint(Array(29).fill('wide text '.repeat(20)), { row: 28, col: 60 });
    assert.ok(stage.prev.every(row => visibleWidth(row) <= Math.max(1, columns - 1)));
    assert.ok(stage.caret.col <= Math.max(0, columns - 2));
  }
});

test('real surface stays suspended through repeated short resizes and recovers', () => {
  const out = { columns: 180, rows: 40, isTTY: true, write: (_text: string) => true };
  const surface = new StageSurface({ out, env: { CAUSYNE_MOUSE: '0' } });
  surface.open();
  surface.enterHome({ version: 'test', provider: 'test', model: 'test' });
  surface.leaveHome(true);
  surface.commit('user', () => ['keep this conversation']);
  surface.present(['INPUT'], { row: 0, col: 2 });
  let state = { current: surface, suspended: null, restored: false } as ReturnType<typeof settleStageResize<typeof surface>>;
  try {
    for (const rows of [10, 9, 8, 15]) {
      out.rows = rows;
      state = settleStageResize(state.current, state.suspended);
      assert.equal(state.current, null, `must remain suspended at ${rows} rows`);
      assert.equal(surface.stage.reserved, false);
    }
    out.rows = 30;
    state = settleStageResize(state.current, state.suspended);
    assert.equal(state.current, surface);
    assert.equal(state.restored, true);
    surface.present(['INPUT'], { row: 0, col: 2 });
    assert.match(stripAnsi(surface.stage.prev.join('\n')), /keep this conversation/);
    assert.match(stripAnsi(surface.stage.prev.at(-1)), /INPUT/);
  } finally { surface.close(); }
});

test('short sidebar keeps the active plan step visible with optional metadata', () => {
  const plan = Array.from({ length: 30 }, (_, i) => ({ text: `STEP_${i}_END`, status: i === 18 ? 'in_progress' : 'pending' }));
  for (const height of [12, 16, 20, 24, 40]) {
    const rows = sessionSidebarRows({ title: 'Session', id: 'session-id', cwd: '/workspace', provider: 'provider', model: 'model', activeSkill: { id: 'skill', description: 'description' }, plan }, height);
    assert.equal(rows.length, height);
    assert.ok(rows.every(row => visibleWidth(row) === 42));
    assert.match(stripAnsi(rows.join('\n')), /STEP_18_END/, `active step hidden at height ${height}`);
  }
});

test('streaming conversation survives repeated width and height changes across the sidebar breakpoint', () => {
  const out = { columns: 200, rows: 50, isTTY: true, write: (_text: string) => true };
  const surface = new StageSurface({ out, env: { CAUSYNE_MOUSE: '0' } });
  surface.open();
  surface.enterHome({ version: 'test', provider: 'test', model: 'test' });
  surface.leaveHome(true);
  try {
    for (let pass = 0; pass < 3; pass++) {
      for (const [columns, rows] of [[200, 50], [161, 24], [160, 18], [80, 40], [24, 18], [180, 50]]) {
        out.columns = columns!;
        out.rows = rows!;
        assert.equal(surface.resize(), true);
        const latest = `message-${pass}-${columns}`;
        surface.commit('assistant', (width: number) => Array.from({ length: 3 }, () => latest.slice(0, width)));
        surface.present(['INPUT'], { row: 0, col: 4 });
        assert.equal(surface.stage.height, surface.stage.maxHeight);
        assert.ok(surface.stage.prev.every(row => visibleWidth(row) < out.columns));
        assert.match(stripAnsi(surface.stage.prev.at(-1)), /INPUT/);
        assert.match(stripAnsi(surface.stage.prev.join('\n')), new RegExp(latest));
        assert.equal(surface.viewport.following, true);
      }
    }
  } finally { surface.close(); }
});
