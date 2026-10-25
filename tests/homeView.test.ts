import { test } from 'node:test';
import assert from 'node:assert/strict';

import { placeHome, placeDialog } from '../src/tui/homeView.js';
import { HomeTransition } from '../src/tui/homeTransition.js';
import { settleStageResize } from '../src/tui/resizeRecovery.js';
import { dialogWidth, dialogHeight } from '../src/tui/layout.js';
import { StageSurface } from '../src/tui/stageSurface.js';
import { ChatPrompt } from '../src/tui/prompt.js';
import { stripAnsi, visibleWidth } from '../src/tui/text.js';

const info = { version: 'v1', provider: 'test', model: 'model', cwd: '/tmp/project' };

test('home contains identity and input but no previous conversation', () => {
  const view = placeHome(info, ['  INPUT'], 156, 77, 0, 3);
  const screen = stripAnsi(view.rows.join('\n'));
  assert.match(screen, /From intention to meaningful progress/);
  assert.match(screen, /INPUT/);
  assert.ok(view.caretRow > 15 && view.caretRow < 65);
  assert.ok(view.rows.every(row => visibleWidth(row) < 156));
});

test('dialogs remain centered and fit after narrow resize', () => {
  for (const [width, height] of [[156, 77], [80, 39], [40, 19], [20, 16]]) {
    const panel = ['╭────╮', '│Menu│', '╰────╯'];
    const view = placeDialog(panel, width, height, 1, 2);
    assert.equal(view.rows.length <= height, true);
    assert.ok(view.caretRow >= 0 && view.caretRow < height);
    assert.ok(dialogWidth(width, 76) < width);
    assert.ok(dialogHeight(height, 20) < height);
  }
});

test('first Home prompt starts fresh; selecting a session preserves it', () => {
  let started = 0;
  let reset = 0;
  const loop = {
    memoryManager: { startNewSession: () => { started++; } },
    messages: [{ role: 'user', content: 'old context' }],
    tokenTracker: { reset: () => { reset++; } }
  };
  const surface = { homeSessionSelected: false, leaveHome() {} };
  const home = new HomeTransition(true, surface);
  home.beginTurn(loop);
  home.beginTurn(loop);
  assert.equal(started, 1);
  assert.equal(reset, 1);
  assert.deepEqual(loop.messages, []);

  const selected = { homeSessionSelected: true };
  const resumed = new HomeTransition(true, selected);
  const loaded = [{ role: 'user', content: 'chosen history' }];
  const selectedLoop = { messages: loaded, memoryManager: { startNewSession: () => { started++; } } };
  resumed.beginTurn(selectedLoop);
  assert.equal(started, 1);
  assert.equal(selectedLoop.messages, loaded);
});

test('the Stage switches from centered Home to centered modal to session footer', () => {
  const out = {
    columns: 100, rows: 40, isTTY: true,
    write: () => true, on() {}, removeListener() {}
  };
  const surface = new StageSurface({ out, env: { CAUSYNE_MOUSE: '0' } });
  try {
    assert.equal(surface.open(), true);
    surface.enterHome(info);
    surface.present(['  PROMPT'], { row: 0, col: 3 });
    assert.match(stripAnsi(surface.stage.prev.join('\n')), /From intention to meaningful progress[\s\S]*PROMPT/);
    assert.equal(surface.transcript.length, 0);

    surface.present(['  ╭────╮', '  │Menu│', '  ╰────╯'], { row: 1, col: 5, modal: true });
    assert.match(stripAnsi(surface.stage.prev.join('\n')), /Menu/);
    assert.doesNotMatch(stripAnsi(surface.stage.prev.join('\n')), /From intention to meaningful progress/);

    surface.leaveHome(true);
    surface.present(['  PROMPT'], { row: 0, col: 3 });
    assert.equal(surface.homeSessionSelected, true);
    assert.ok(surface.stage.prev.at(-1)?.includes('PROMPT'));

    out.columns = 60;
    out.rows = 24;
    assert.equal(surface.resize(), true);
    surface.present(['  PROMPT'], { row: 0, col: 3 });
    assert.ok(surface.stage.prev.every(row => visibleWidth(row) < 60));
  } finally {
    surface.close();
  }
});

test('a stage recovers after a temporary terminal height below its minimum', () => {
  let available = false;
  const stage = {
    stage: { maxHeight: 0 },
    resize() { this.stage.maxHeight = available ? 30 : 0; return false; },
    open() { return this.stage.maxHeight > 0; }
  };
  let state = settleStageResize(stage, null);
  assert.equal(state.current, null);
  assert.equal(state.suspended, stage);
  available = true;
  state = settleStageResize(state.current, state.suspended);
  assert.equal(state.restored, true);
  assert.equal(state.current, stage);
});

test('rapid terminal resize settles once and restores the Home composer', async () => {
  const out = {
    columns: 100, rows: 40, isTTY: true,
    write: () => true, on() {}, removeListener() {}
  };
  const surface = new StageSurface({ out, env: { CAUSYNE_MOUSE: '0' } });
  const input = { isTTY: true, setRawMode() {}, resume() {}, pause() {}, on() {}, off() {} };
  const prompt = new ChatPrompt({ out, input, surface });
  try {
    assert.equal(surface.open(), true);
    surface.enterHome(info);
    prompt.attachSurface(surface);
    prompt.active = true;
    prompt.draw();
    const before = surface.stage.stats.paints;

    for (let width = 99; width >= 60; width--) {
      out.columns = width;
      prompt.handleResize();
    }
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(prompt.surface, surface);
    assert.ok(surface.stage.stats.paints <= before + 2, 'the drag should produce one settled repaint');
    assert.ok(surface.stage.prev.every(row => visibleWidth(row) < out.columns));

    out.rows = 8;
    prompt.handleResize();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(prompt.surface, null);

    out.rows = 40;
    prompt.handleResize();
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(prompt.surface, surface);
    assert.match(stripAnsi(surface.stage.prev.join('\n')), /C A U S Y N E  A G E N T/);
  } finally {
    prompt.active = false;
    if (prompt.resizeTimer) clearTimeout(prompt.resizeTimer);
    surface.close();
  }
});
