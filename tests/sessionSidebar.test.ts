import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sidebarVisible, sessionMainWidth, sessionComposerWidth, sessionSidebarRows } from '../src/tui/sessionSidebar.js';
import { StageSurface } from '../src/tui/stageSurface.js';
import { stripAnsi, visibleWidth } from '../src/tui/text.js';

const info = { version: 'v1', provider: 'test', model: 'model', cwd: '/tmp/work' };

function createSurface(columns: number, rows = 40) {
  const out = { columns, rows, isTTY: true, write: () => true, on() {}, removeListener() {} };
  const surface = new StageSurface({ out, env: { CAUSYNE_MOUSE: '0' } });
  assert.equal(surface.open(), true);
  return { out, surface };
}

test('the sidebar appears only when its conversation column can remain readable', () => {
  assert.equal(sidebarVisible(120), false);
  assert.equal(sidebarVisible(121), true);
  assert.equal(sidebarVisible(154, true), false);
  assert.equal(sessionMainWidth(154), 111);
  assert.equal(sessionMainWidth(100), 100);
  assert.equal(sessionComposerWidth(sessionMainWidth(154)), 108);
  const rows = sessionSidebarRows({ title: 'Work', cwd: '/tmp/work', contextChars: 250, contextLimit: 1000 }, 30);
  assert.equal(rows.length, 30);
  assert.ok(rows.every(row => visibleWidth(row) === 42));
  assert.match(stripAnsi(rows.join('\n')), /25% of available window/);
});

test('wide Home becomes a full-height two-column session', () => {
  const { surface } = createSurface(154);
  try {
    surface.enterHome(info);
    surface.present(['  INPUT'], { row: 0, col: 4 });
    surface.leaveHome();
    surface.commit('user', () => ['hello']);
    surface.sidebarStatus = { cwd: '/tmp/work', contextChars: 250, contextLimit: 1000 };
    surface.present(['  INPUT'], { row: 0, col: 4 });
    const screen = stripAnsi(surface.stage.prev.join('\n'));
    assert.equal(surface.stage.height, surface.stage.maxHeight);
    assert.match(screen, /hello/);
    assert.match(screen, /25% of available window/);
    assert.ok(surface.stage.prev.every(row => visibleWidth(row) < 154));
    assert.ok(surface.stage.prev.at(-1)?.includes('INPUT'));
  } finally {
    surface.close();
  }
});

test('narrow Home becomes a compact session with no blank vertical band', () => {
  const { out, surface } = createSurface(100);
  try {
    surface.enterHome(info);
    surface.present(['  INPUT'], { row: 0, col: 4 });
    assert.equal(surface.stage.height, surface.stage.maxHeight);
    surface.leaveHome();
    surface.commit('user', () => ['hello']);
    surface.present(['  INPUT'], { row: 0, col: 4 });
    assert.ok(surface.stage.height < 8, 'the old full-height Home region must collapse');
    assert.doesNotMatch(stripAnsi(surface.stage.prev.join('\n')), /Context/);
    assert.ok(surface.stage.prev.every(row => visibleWidth(row) < out.columns));

    out.columns = 154;
    assert.equal(surface.resize(), true);
    surface.present(['  INPUT'], { row: 0, col: 4 });
    assert.equal(surface.stage.height, surface.stage.maxHeight);
    assert.match(stripAnsi(surface.stage.prev.join('\n')), /Context/);

    out.columns = 80;
    assert.equal(surface.resize(), true);
    surface.present(['  INPUT'], { row: 0, col: 4 });
    assert.ok(surface.stage.height < 8);
    assert.doesNotMatch(stripAnsi(surface.stage.prev.join('\n')), /Context/);
  } finally {
    surface.close();
  }
});
