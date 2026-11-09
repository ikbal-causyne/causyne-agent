import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Transcript } from '../src/tui/transcript.js';
import { Viewport } from '../src/tui/viewport.js';
import { Stage } from '../src/tui/stage.js';
import { StageSurface } from '../src/tui/stageSurface.js';
import { ChatRenderer } from '../src/tui/chatRenderer.js';
import { buildTurnRailCells } from '../src/tui/turnRail.js';
import { visibleWidth, stripAnsi } from '../src/tui/text.js';

function terminal(columns = 100, rows = 40) {
  const bytes = [];
  return {
    columns, rows, isTTY: true,
    write(chunk) { bytes.push(String(chunk)); return true; },
    on() {}, removeListener() {},
    bytes
  };
}

test('viewport reflow keeps the visible frame while manually scrolled', () => {
  const transcript = new Transcript();
  for (let index = 0; index < 12; index++) {
    const long = `Frame ${index} ${'paragraph '.repeat(100)}`;
    transcript.append({ kind: 'user', produce: width => {
      const output = [];
      const lineWidth = Math.max(10, width - 6);
      for (let i = 0; i < long.length; i += lineWidth) output.push(long.slice(i, i + lineWidth));
      return output;
    }});
  }
  const viewport = new Viewport({ transcript, height: 18, width: 110 });
  const old = transcript.markers(110);
  viewport.scrollTo(old[6].row + 3);
  assert.equal(viewport.manual, true);
  const anchorId = old[6].id;
  viewport.resize({ height: 22, width: 64 });
  const markers = transcript.markers(64);
  const index = markers.findIndex(marker => marker.id === anchorId);
  assert.ok(index >= 0);
  assert.ok(viewport.scrollTop >= markers[index].row);
  assert.ok(viewport.scrollTop < markers[index + 1].row);
  assert.equal(viewport.manual, true);
});

test('Stage caret position cannot run into the wrap column', () => {
  const output = terminal(60, 25);
  const stage = new Stage({ out: output, height: 12 });
  stage.reserve(12);
  stage.paint(['caption', 'input'], { row: 1, col: 9999 });
  assert.ok(stage.caret.col <= output.columns - 2);
  stage.collapse();
});

test('sidebar + overview rail + composer keep physical rows under terminal width', () => {
  for (const columns of [60, 80, 100, 119, 120, 154, 200]) {
    const output = terminal(columns, 40);
    const surface = new StageSurface({ out: output, env: { CAUSYNE_RAIL: '1' } });
    surface.open();
    try {
      surface.setSessionInfo({ title: 'Layout verification', cwd: '/workspace/very/long/project/name', model: 'long-model-configuration' });
      for (let i = 0; i < 35; i++) {
        surface.commit('step', width => ['• '.repeat(width)]);
      }
      surface.present(['compose ' + 'x'.repeat(columns)], { row: 0, col: columns * 2 });
      assert.ok(surface.stage.prev.every(row => visibleWidth(row) < columns), `overflow at ${columns} cols`);
      assert.ok(surface.stage.caret.col <= columns - 2);
    } finally { surface.close(); }
  }
});

test('dense turn rail is sparse without losing active/hovered navigation', () => {
  const turns = Array.from({ length: 100 }, (_, i) => ({
    turnIndex: i + 1, totalTurns: 100,
    userPrompt: `Task ${i}`, assistantSummary: '',
    timestamp: i, formattedDate: '12:00', frameId: i, startRow: i * 10
  }));
  const painted = buildTurnRailCells(turns, 50, 100, 32);
  const dots = painted.cells.map(stripAnsi).filter(cell => cell.trim() !== '');
  assert.ok(dots.length <= 25, `too many noisy markers: ${dots.length}`);
  assert.equal(painted.layout.dotRows.size, 100);
  assert.equal(painted.layout.rowToTurn.get(painted.layout.dotRows.get(32)), 32);
  assert.ok(painted.cells[painted.layout.dotRows.get(100)]?.includes('●'));
  assert.ok(painted.cells[painted.layout.dotRows.get(32)]?.includes('●'));
});

test('eighth silent tool result becomes a single finished step, with no lost data', () => {
  const output = terminal(100, 40);
  const transcript = new Transcript();
  const renderer = new ChatRenderer({ out: output, transcript });
  for (let i = 1; i <= 8; i++) {
    renderer.onStepStart({ tool: 'run', args: { command: `echo ${i}` } });
    renderer.onStepComplete({ tool: 'run', result: { success: true }, elapsed: '20ms' });
  }
  assert.equal(transcript.length, 15, 'first seven retain two frames, eighth is compact');
  assert.equal(transcript.frames.at(-1)?.kind, 'step');
  assert.equal(transcript.frames.at(-1)?.meta?.success, true);
  assert.ok(transcript.rows(100).join('\n').includes('20ms'));
});

test('failures after threshold retain a separate detailed result frame', () => {
  const output = terminal(100, 40);
  const transcript = new Transcript();
  const renderer = new ChatRenderer({ out: output, transcript });
  for (let i = 0; i < 8; i++) {
    renderer.onStepStart({ tool: 'run', args: { command: 'false' } });
    renderer.onStepComplete({ tool: 'run', result: { success: false, error: 'boom' }, elapsed: '5ms' });
  }
  assert.equal(transcript.length, 16);
  assert.equal(transcript.frames.at(-1)?.kind, 'result');
  assert.ok(transcript.rows(100).join('\n').includes('boom'));
});


test('turn rail reserves its lane and keeps the end of long tool commands visible', () => {
  const output = terminal(100, 30);
  const surface = new StageSurface({ out: output, env: { CAUSYNE_RAIL: '1', CAUSYNE_SIDEBAR: '0' } });
  surface.open();
  try {
    surface.commit('user', () => ['start the workflow']);
    surface.commit('step', width => ['x'.repeat(Math.max(0, width - 'END_SENTINEL'.length)) + 'END_SENTINEL']);
    surface.present(['INPUT'], { row: 0, col: 0 });
    const text = surface.stage.prev.map(stripAnsi).join('\n');
    assert.ok(text.includes('END_SENTINEL'), 'rail marker may not truncate the tail of a command');
    assert.ok(surface.stage.prev.every(row => visibleWidth(row) < 100));
  } finally { surface.close(); }
});
