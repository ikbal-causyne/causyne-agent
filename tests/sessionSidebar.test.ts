import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sidebarVisible, sessionMainWidth, sessionComposerWidth, sessionSidebarRows } from '../src/tui/sessionSidebar.js';
import { StageSurface } from '../src/tui/stageSurface.js';
import { stripAnsi, visibleWidth } from '../src/tui/text.js';
import { isStartupDialog, startupDialogView } from '../src/tui/homeView.js';
// @ts-expect-error dialogs.js is awaiting TypeScript migration.
import { SelectLayer, TextLayer } from '../src/tui/dialogs.js';
// @ts-expect-error prompt.js is awaiting TypeScript migration.
import { ChatPrompt } from '../src/tui/prompt.js';

const info = { version: 'v1', provider: 'test', model: 'model', cwd: '/tmp/work' };

function createSurface(columns: number, rows = 40) {
  const out = { columns, rows, isTTY: true, write: () => true, on() {}, removeListener() {} };
  const surface = new StageSurface({ out, env: { CAUSYNE_MOUSE: '0' } });
  assert.equal(surface.open(), true);
  return { out, surface };
}

test('the sidebar appears only when its conversation column can remain readable', () => {
  assert.equal(sidebarVisible(120), false);
  assert.equal(sidebarVisible(121), false);
  assert.equal(sidebarVisible(160), false);
  assert.equal(sidebarVisible(161), true);
  assert.equal(sidebarVisible(154, true), false);
  process.env.CAUSYNE_SIDEBAR = 'off';
  assert.equal(sidebarVisible(154), false);
  delete process.env.CAUSYNE_SIDEBAR;
  assert.equal(sessionMainWidth(154), 154);
  assert.equal(sessionMainWidth(200), 157);
  assert.equal(sessionMainWidth(100), 100);
  assert.ok(sessionComposerWidth(sessionMainWidth(154)) <= 150);
  const rows = sessionSidebarRows({ title: 'Work', cwd: '/tmp/work', contextChars: 250, contextLimit: 1000 }, 30);
  assert.equal(rows.length, 30);
  assert.ok(rows.every(row => visibleWidth(row) === 42));
  assert.match(stripAnsi(rows.join('\n')), /25% of available window/);

  const unmeasured = sessionSidebarRows({ title: 'Work', cwd: '/tmp/work', contextChars: 0, contextLimit: 1000 }, 30);
  assert.match(stripAnsi(unmeasured.join('\n')), /No context measurement yet/);
  assert.ok(!stripAnsi(unmeasured.join('\n')).includes('0% of available window'));
});

test('wide Home becomes a full-height two-column session', () => {
  const { surface } = createSurface(200);
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
    assert.ok(surface.stage.prev.every(row => visibleWidth(row) < 200));
    assert.ok(surface.stage.prev.at(-1)?.includes('INPUT'));
  } finally {
    surface.close();
  }
});

test('a selected session keeps its input at the bottom as the sidebar appears and disappears', () => {
  const { out, surface } = createSurface(99, 71);
  try {
    surface.enterHome(info);
    surface.present(['  INPUT'], { row: 0, col: 4 });
    assert.equal(surface.stage.height, surface.stage.maxHeight);
    surface.leaveHome();
    surface.commit('user', () => ['hello']);
    surface.present(['  INPUT'], { row: 0, col: 4 });
    assert.equal(surface.stage.height, surface.stage.maxHeight);
    assert.doesNotMatch(stripAnsi(surface.stage.prev.join('\n')), /Context/);
    assert.ok(surface.stage.prev.every(row => visibleWidth(row) < out.columns));
    assert.match(stripAnsi(surface.stage.prev.at(-1) || ''), /INPUT/);

    out.columns = 200;
    assert.equal(surface.resize(), true);
    surface.present(['  INPUT'], { row: 0, col: 4 });
    assert.equal(surface.stage.height, surface.stage.maxHeight);
    assert.match(stripAnsi(surface.stage.prev.join('\n')), /Context/);

    out.columns = 80;
    assert.equal(surface.resize(), true);
    surface.present(['  INPUT'], { row: 0, col: 4 });
    assert.equal(surface.stage.height, surface.stage.maxHeight);
    assert.doesNotMatch(stripAnsi(surface.stage.prev.join('\n')), /Context/);
    assert.match(stripAnsi(surface.stage.prev.at(-1) || ''), /INPUT/);
  } finally {
    surface.close();
  }
});

test('session transcript stays directly above input at 145x69', () => {
  const { surface } = createSurface(145, 69);
  try {
    surface.enterHome(info);
    surface.present(['INPUT'], { row: 0, col: 0 });
    surface.leaveHome(true);
    for (let i = 1; i <= 8; i++) surface.commit('user', () => [`message ${i}`]);
    surface.present(['INPUT'], { row: 0, col: 0 });
    const mainRows = surface.stage.prev.map(row => stripAnsi(row).slice(0, sessionMainWidth(145)));
    const lastMessage = mainRows.findLastIndex(row => row.includes('message 8'));
    assert.ok(mainRows.some(row => row.includes('message 1')), 'short sessions must retain their first message');
    assert.ok(lastMessage >= mainRows.length - 3, 'last message must be close to input');
    assert.match(mainRows.at(-1) || '', /INPUT/);
  } finally {
    surface.close();
  }
});

test('an active plan stays in the sidebar and an inline decision keeps the transcript visible', () => {
  const { surface } = createSurface(200, 50);
  try {
    surface.enterHome(info);
    surface.leaveHome(true);
    surface.commit('user', () => ['request to build a page']);
    surface.sidebarPlan = [
      { text: 'Inspect the workspace', status: 'completed' },
      { text: 'Choose the layout', status: 'in_progress' }
    ];
    surface.present(['CHOOSE ARCHITECTURE', 'Vanilla HTML', 'React'], { row: 1, col: 0, modal: true, inline: true });
    const screen = stripAnsi(surface.stage.prev.join('\n'));
    assert.match(screen, /request to build a page/);
    assert.match(screen, /CHOOSE ARCHITECTURE/);
    assert.match(screen, /Plan  1\/2/);
    assert.match(screen, /Choose the layout/);
    assert.ok(surface.stage.prev.every(row => visibleWidth(row) < 200));
  } finally {
    surface.close();
  }
});

test('startup pickers stay centered and bounded even with a long list', () => {
  const { surface } = createSurface(161, 78);
  try {
    surface.enterHome(info);
    const layer = new SelectLayer({
      title: 'Sessions',
      width: 78,
      items: Array.from({ length: 100 }, (_, index) => ({ id: String(index), label: `Session ${index}`, category: 'Today' }))
    });
    assert.equal(isStartupDialog(surface), true);
    const view = startupDialogView(layer, 161, 78);
    assert.equal(view.rows.length, 30, 'a long catalogue must not grow past the fixed height');
    assert.ok(view.rows.every(row => visibleWidth(row) < 161));
    assert.match(stripAnsi(view.rows[0] || ''), /^ {20,}[+╭]/, 'the panel must have a horizontal inset');

    const prompt = new ChatPrompt({ out: surface.out, surface });
    prompt.active = true;
    prompt.attachSurface(surface);
    prompt.openLayer(layer);
    const screen = surface.stage.prev.map(row => stripAnsi(row));
    const titleRow = screen.findIndex(row => row.includes('Sessions'));
    assert.ok(titleRow > 10 && titleRow < 45, 'the modal must be vertically centered');
    assert.ok(screen[titleRow]?.indexOf('Sessions') > 20, 'the modal must be horizontally centered');
    assert.ok(surface.stage.prev.every(row => visibleWidth(row) < 161));
    prompt.active = false;
  } finally {
    surface.close();
  }
});

test('a short startup dialog has a readable minimum size and an active chat remains inline', () => {
  const { surface } = createSurface(99, 40);
  try {
    surface.enterHome(info);
    const layer = new TextLayer({ title: 'Plugins', lines: ['No local plugins.'] });
    const startup = startupDialogView(layer, 99, 40);
    assert.ok(startup.rows.length >= 10);
    for (const columns of [40, 80, 161]) {
      const view = startupDialogView(layer, columns, 17);
      assert.ok(view.rows.length <= 15);
      assert.ok(view.rows.every(row => visibleWidth(row) < columns));
    }
    surface.leaveHome(true);
    surface.commit('user', () => ['a real conversation']);
    assert.equal(isStartupDialog(surface), false);
  } finally {
    surface.close();
  }
});

test('repeated sidebar breakpoint resizing reflows in place without scrolling or ghost panels', () => {
  const writes: string[] = [];
  const out = {
    columns: 163, rows: 78, isTTY: true,
    write: (chunk: string) => { writes.push(String(chunk)); return true; },
    on() {}, removeListener() {}
  };
  const surface = new StageSurface({ out, env: { CAUSYNE_MOUSE: '0' } });
  assert.equal(surface.open(), true);
  try {
    surface.enterHome(info);
    surface.leaveHome(true);
    surface.commit('user', () => ['sidebar resize regression']);
    surface.sidebarStatus = {
      cwd: '/workspace/suika-game',
      contextChars: 300,
      contextLimit: 1000
    };
    surface.present(['TYPE HERE'], { row: 0, col: 3 });
    const initialClaims = surface.stage.stats.claimed;
    for (const columns of [160, 158, 130, 161, 163, 159, 200, 95, 163]) {
      out.columns = columns;
      const beforeWrite = writes.length;
      assert.equal(surface.resize(), true);
      surface.present(['TYPE HERE'], { row: 0, col: 3 });
      assert.equal(surface.stage.stats.claimed, initialClaims,
        'width-only resize must never claim rows or scroll the terminal');
      assert.ok(!writes.slice(beforeWrite).join('').includes('\n'),
        'width-only resize must repaint without newlines');
      const rendered = surface.stage.prev.map(row => stripAnsi(row || ''));
      assert.ok(rendered.every(row => visibleWidth(row) < columns), 'rows must not wrap');
      assert.match(rendered.at(-1) || '', /TYPE HERE/, 'composer stays visible');
      if (columns > 160) {
        assert.match(rendered.join('\n'), /Context/, 'sidebar must be repainted after reopening');
        assert.match(rendered.join('\n'), /suika-game/);
      } else {
        assert.doesNotMatch(rendered.join('\n'), /30% of available window/,
          'sidebar must fully disappear at the responsive breakpoint');
      }
    }
  } finally {
    surface.close();
  }
});

test('sidebar visibility and composer layout honor the stage environment consistently', () => {
  const env = { CAUSYNE_SIDEBAR: 'off', CAUSYNE_MOUSE: '0' };
  assert.equal(sidebarVisible(200, false, env), false);
  assert.equal(sessionMainWidth(200, false, env), 200);
  const out = {
    columns: 200, rows: 40, isTTY: true,
    write: () => true, on() {}, removeListener() {}
  };
  const surface = new StageSurface({ out, env });
  assert.equal(surface.open(), true);
  try {
    surface.enterHome(info);
    surface.leaveHome(true);
    surface.commit('user', () => ['sidebar environment test']);
    surface.present(['COMPOSER'], { row: 0, col: 2 });
    const output = stripAnsi(surface.stage.prev.join('\n'));
    assert.doesNotMatch(output, /No context measurement yet/);
    assert.equal(surface.composeAvailableWidth(), 200);
    assert.equal(surface.stage.prev.at(-1)?.includes('COMPOSER'), true);
  } finally {
    surface.close();
  }
});
