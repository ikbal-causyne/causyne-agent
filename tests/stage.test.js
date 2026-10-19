// The Stage owns a REGION, never the screen.
//
// This is the guard for the amendment to UX-01. The old rule was "never own a
// screen", and it was one generalisation too strong: the bug it came from was
// an UNCONDITIONAL, UNDETECTABLE takeover that erased rows the app did not own
// (screen.js wrote ALT_ENTER + HOME + CLEAR_ALL, ?1049h cannot be feature
// detected, and where it is ignored the clear that follows destroys the user's
// screen). A bottom-anchored band repainted with relative motion cannot do
// that — and these tests are what make "cannot" true rather than "intends not
// to".
//
// The four load-bearing invariants:
//
//   1. paint() emits no newline, ever. One '\n' on the band's last row scrolls
//      the terminal out from under the block and every relative move after it
//      lands on the wrong row.
//   2. paint() emits no absolute cursor addressing. Absolute positioning
//      assumes we know where we are on a screen we do not own.
//   3. An unchanged frame costs zero bytes.
//   4. Every row written fits in width - 1, because a wrapped row occupies two
//      physical rows and desynchronises the diff exactly as it did in the
//      live-region bug of 2026-09-01.
//
// Width is varied with a synthetic sink, never a pty — see MS-02: terminalWidth()
// reads the pty ioctl, so `COLUMNS=N script -q` measures the same width three
// times and reports false results.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Stage, stageHeight, stageEnabled, MIN_STAGE_ROWS } from '../src/tui/stage.js';
import { StageSurface } from '../src/tui/stageSurface.js';
import { Transcript } from '../src/tui/transcript.js';
import { ChatRenderer } from '../src/tui/chatRenderer.js';
import { visibleWidth, stripAnsi } from '../src/tui/text.js';

function sink({ columns = 100, rows = 40, isTTY = true } = {}) {
  const chunks = [];
  return {
    columns,
    rows,
    isTTY,
    write(text) { chunks.push(text); return true; },
    on() {}, removeListener() {},
    text: () => chunks.join(''),
    reset: () => { chunks.length = 0; },
    chunks
  };
}

function band(height, fillWith = (i) => `row ${i}`) {
  return Array.from({ length: height }, (_, i) => fillWith(i));
}

// ---------------------------------------------------------------------------

describe('stage sizing decides honestly, and refuses rather than degrades', () => {
  test('auto leaves one seam row above the band', () => {
    assert.equal(stageHeight(sink({ rows: 40 }), {}), 39);
    assert.equal(stageHeight(sink({ rows: 24 }), {}), 23);
  });

  test('a terminal too short for a viewport gets no stage at all', () => {
    // Not a cramped stage — the scrollback renderer, unchanged. A 10-row band
    // cannot hold a viewport plus an input box plus a footer, and pretending
    // otherwise is worse than the honest fallback.
    assert.equal(stageHeight(sink({ rows: 12 }), {}), 0);
    // The seam row is not negotiable, so the floor bites one row late: a
    // terminal of exactly MIN_STAGE_ROWS can only offer MIN_STAGE_ROWS - 1.
    assert.equal(stageHeight(sink({ rows: MIN_STAGE_ROWS }), {}), 0);
    assert.equal(stageHeight(sink({ rows: MIN_STAGE_ROWS + 1 }), {}), MIN_STAGE_ROWS);
  });

  test('CAUSYNE_STAGE takes rows, percentages and off', () => {
    const out = sink({ rows: 50 });
    assert.equal(stageHeight(out, { CAUSYNE_STAGE: 'off' }), 0);
    assert.equal(stageHeight(out, { CAUSYNE_STAGE: '0' }), 0);
    assert.equal(stageHeight(out, { CAUSYNE_STAGE: '20' }), 20);
    assert.equal(stageHeight(out, { CAUSYNE_STAGE: '50%' }), 25);
    // A request larger than the terminal still leaves the seam row.
    assert.equal(stageHeight(out, { CAUSYNE_STAGE: '999' }), 49);
    // Below the floor it refuses rather than shrinking into uselessness.
    assert.equal(stageHeight(out, { CAUSYNE_STAGE: '4' }), 0);
  });

  test('every reason the region could not be repainted safely falls back', () => {
    assert.equal(stageEnabled(sink({ rows: 40 }), {}), true);
    assert.equal(stageEnabled(sink({ rows: 40, isTTY: false }), {}), false);
    assert.equal(stageEnabled(sink({ rows: 40 }), { TERM: 'dumb' }), false);
    assert.equal(stageEnabled(sink({ rows: 40 }), { CAUSYNE_SIMPLE_INPUT: '1' }), false);
    assert.equal(stageEnabled(sink({ rows: 8 }), {}), false);
  });
});

// ---------------------------------------------------------------------------

describe('UX-01 rev 2 — the band is reserved, never seized', () => {
  test('reserve emits newlines and nothing else', () => {
    const out = sink({ rows: 30 });
    const stage = new Stage({ out, env: {} });
    // The ceiling is not the size: a band claimed by printing costs a real row
    // of the user's terminal for every row it takes, so it starts at what it
    // needs and grows. reserve() with no argument still claims the ceiling.
    assert.equal(stage.maxHeight, 29);
    assert.equal(stage.height, 0, 'nothing is claimed until it is asked for');
    assert.equal(stage.reserve(), true);

    const text = out.text();
    assert.equal(text, '\n'.repeat(29),
      'the band is claimed by printing, exactly as any program that prints claims rows');
    assert.equal(stage.height, 29);
    assert.equal(stage.cursor, 28, 'the caret ends on the band last row');
  });

  test('no takeover escape survives a full session', () => {
    const out = sink({ rows: 30 });
    const stage = new Stage({ out, env: {} });
    stage.reserve();
    stage.paint(band(29), { row: 28, col: 4 });
    stage.paint(band(29, (i) => `changed ${i}`), { row: 28, col: 4 });
    stage.collapse();
    stage.printThrough(['a', 'b']);

    const text = out.text();
    assert.ok(!text.includes('\x1b[?1049h'), 'no alternate buffer');
    assert.ok(!text.includes('\x1b[?1049l'), 'no alternate buffer');
    assert.ok(!text.includes('\x1b[2J'), 'no whole-screen erase');
    assert.ok(!text.includes('\x1b[3J'), 'no scrollback erase');
    assert.ok(!/\x1b\[\d*;\d*[Hf]/.test(text),
      'no absolute cursor addressing — it assumes a screen we do not own');
  });

  test('paint never emits a newline', () => {
    // The single most important byte-level invariant. A newline on the band's
    // last row scrolls the terminal, and every relative move afterwards lands
    // one row off — the same class of failure as the wrapped-row bug.
    const out = sink({ rows: 30 });
    const stage = new Stage({ out, env: {} });
    stage.reserve();
    out.reset();

    for (let n = 0; n < 5; n++) {
      stage.paint(band(29, (i) => `pass ${n} row ${i}`), { row: 20, col: 3 });
    }
    assert.ok(!out.text().includes('\n'), 'paint moves with CUU/CUD only');
  });

  test('collapse gives the band back and print-through makes it history', () => {
    const out = sink({ rows: 30 });
    const stage = new Stage({ out, env: {} });
    stage.reserve();
    stage.paint(band(29), { row: 28, col: 0 });
    out.reset();

    stage.collapse();
    const collapsed = out.text();
    assert.ok(collapsed.includes('\x1b[J'), 'the band is erased from its own top row down');
    assert.ok(collapsed.includes('\x1b[28A'), 'it walks up to its own top row first');
    assert.equal(stage.reserved, false);

    out.reset();
    stage.printThrough(['one', 'two', 'three']);
    assert.equal(out.text(), 'one\ntwo\nthree\n',
      'the exit contract: the session becomes permanent terminal history');
  });
});

// ---------------------------------------------------------------------------

describe('the band breathes — UX-03', () => {
  // THE GAP, and why it is the same bug as before by another road.
  //
  // UX-01 originally addressed a visible gap. The
  // old cause was a screen clear on a terminal that ignored ?1049h. That cause is
  // gone. The SYMPTOM came back anyway, because the band was sized to the SCREEN
  // rather than to its CONTENT — which is free on an alternate screen, where you
  // already own every row, and on a band claimed by printing newlines is
  // catastrophic.
  //
  // Measured on a 156x78 pty: the banner's 12 rows plus a 77-row
  // band came to 89 on a 78-row screen, so the wordmark was scrolled 11 rows out
  // of sight before he had typed anything, and 73 of the 77 claimed rows were
  // empty. Every UX-01 escape check passed the whole time.
  //
  // A rule that cannot see the defect it was written for is not a guard. These
  // are measurements, not greps.

  function breathingHost({ rows = 78, columns = 156 } = {}) {
    const out = sink({ rows, columns });
    const surface = new StageSurface({ out, env: {} });
    surface.open();
    return { surface, out };
  }

  test('an empty session claims what it needs and not one row more', () => {
    const { surface } = breathingHost();
    assert.equal(surface.stage.maxHeight, 77, 'the ceiling is still the screen');
    assert.equal(surface.stage.height, 1, 'but nothing is claimed before there is something to show');

    surface.present(['input row', 'spacer', 'agent row', 'status'], { row: 0, col: 0 });
    assert.equal(surface.stage.height, 4, 'exactly the prompt');
    assert.equal(surface.stage.prev.filter((r) => r.trim() === '').length, 0,
      'and not one blank row — the void was 73 of 77 before this');
  });

  test('the first paint fits the screen, with room to spare', () => {
    const { surface, out } = breathingHost();
    surface.present(['input row', 'spacer', 'agent row', 'status'], { row: 0, col: 0 });
    const emitted = (out.text().match(/\n/g) || []).length;
    assert.ok(emitted < 78, `${emitted} rows emitted onto a 78-row screen would scroll the banner away`);
    assert.equal(emitted, 4);
  });

  test('it grows with the transcript, up to the ceiling, and never past it', () => {
    const { surface } = breathingHost();
    surface.present(['status'], { row: 0, col: 0 });
    assert.equal(surface.stage.height, 1);

    for (let i = 0; i < 20; i++) {
      surface.transcript.append({ kind: 'notice', produce: () => [`row ${i}`] });
    }
    surface.present(['status'], { row: 0, col: 0 });
    assert.equal(surface.stage.height, 21, 'the prompt plus twenty rows of transcript');

    for (let i = 0; i < 500; i++) {
      surface.transcript.append({ kind: 'notice', produce: () => [`more ${i}`] });
    }
    surface.present(['status'], { row: 0, col: 0 });
    assert.equal(surface.stage.height, 77, 'and it stops at the ceiling');
  });

  test('it never shrinks back', () => {
    // Shrinking would mean erasing rows the diff believes it owns, and fighting
    // the resize path for them. A band that has earned its height keeps it.
    const { surface } = breathingHost();
    for (let i = 0; i < 30; i++) {
      surface.transcript.append({ kind: 'notice', produce: () => [`row ${i}`] });
    }
    surface.present(['status'], { row: 0, col: 0 });
    const grown = surface.stage.height;
    assert.ok(grown > 10);

    surface.transcript.clear();
    surface.present(['status'], { row: 0, col: 0 });
    assert.equal(surface.stage.height, grown);
  });

  test('growth appends at the bottom, so the diff keeps what it already knew', () => {
    const { surface } = breathingHost();
    surface.present(['a', 'b'], { row: 0, col: 0 });
    assert.deepEqual(surface.stage.prev, ['a', 'b']);

    surface.transcript.append({ kind: 'notice', produce: () => ['fresh'] });
    surface.stage.grow(3);
    assert.equal(surface.stage.prev.length, 5);
    assert.deepEqual(surface.stage.prev.slice(0, 2), ['a', 'b'], 'the known rows survive');
    assert.deepEqual(surface.stage.prev.slice(2), [null, null, null], 'the new ones arrive unknown');
  });

  test('every newline is a claimed row — growth included', () => {
    const { surface, out } = breathingHost();
    for (let i = 0; i < 40; i++) {
      surface.transcript.append({ kind: 'notice', produce: () => [`row ${i}`] });
      surface.present(['status'], { row: 0, col: 0 });
    }
    assert.equal((out.text().match(/\n/g) || []).length, surface.stage.stats.claimed);
    assert.ok(surface.stage.stats.claimed > 1, 'it really did grow');
  });

  test('a short terminal still gets a band that grows', () => {
    const { surface } = breathingHost({ rows: 20 });
    assert.equal(surface.stage.maxHeight, 19);
    for (let i = 0; i < 50; i++) {
      surface.transcript.append({ kind: 'notice', produce: () => [`row ${i}`] });
    }
    surface.present(['status'], { row: 0, col: 0 });
    assert.equal(surface.stage.height, 19);
  });
});

// ---------------------------------------------------------------------------

describe('the paint is a diff', () => {
  test('an unchanged frame costs zero bytes', () => {
    const out = sink({ rows: 30 });
    const stage = new Stage({ out, env: {} });
    stage.reserve();
    const rows = band(29);
    stage.paint(rows, { row: 28, col: 2 });
    out.reset();

    assert.equal(stage.paint(rows, { row: 28, col: 2 }), 0);
    assert.equal(out.text(), '', 'a frame with nothing to say emits nothing at all');
  });

  test('a spinner tick rewrites one row, not the band', () => {
    const out = sink({ rows: 40 });
    const stage = new Stage({ out, env: {} });
    stage.reserve();
    const rows = band(39);
    stage.paint(rows, { row: 38, col: 0 });
    out.reset();

    const next = rows.slice();
    next[38] = 'spinner tick';
    assert.equal(stage.paint(next, { row: 38, col: 0 }), 1);

    const text = out.text();
    assert.ok(text.includes('spinner tick'));
    assert.ok(!text.includes('row 0'), 'untouched rows are not rewritten');
    assert.ok(text.length < 120, `one row should be cheap, wrote ${text.length} bytes`);
  });

  test('a scroll rewrites every row, and that is fine', () => {
    const out = sink({ rows: 40 });
    const stage = new Stage({ out, env: {} });
    stage.reserve();
    stage.paint(band(39, (i) => `line ${i}`), { row: 38, col: 0 });
    out.reset();

    const scrolled = stage.paint(band(39, (i) => `line ${i + 1}`), { row: 38, col: 0 });
    assert.equal(scrolled, 39, 'a scroll changes every row by definition');
  });

  test('moving only the caret is still a frame worth emitting', () => {
    const out = sink({ rows: 30 });
    const stage = new Stage({ out, env: {} });
    stage.reserve();
    const rows = band(29);
    stage.paint(rows, { row: 28, col: 0 });
    out.reset();

    assert.equal(stage.paint(rows, { row: 28, col: 9 }), 0, 'no row changed');
    assert.ok(out.text().includes('\x1b[9C'), 'but the caret still has to move');
  });

  test('invalidate forces a full redraw after something wrote behind our back', () => {
    const out = sink({ rows: 30 });
    const stage = new Stage({ out, env: {} });
    stage.reserve();
    const rows = band(29);
    stage.paint(rows, { row: 28, col: 0 });
    stage.invalidate();
    assert.equal(stage.paint(rows, { row: 28, col: 0 }), 29);
  });
});

// ---------------------------------------------------------------------------

describe('the width clamp is the invariant everything rests on', () => {
  for (const columns of [40, 60, 80, 102, 120, 200]) {
    test(`no row exceeds width - 1 at ${columns} columns`, () => {
      const out = sink({ columns, rows: 30 });
      const stage = new Stage({ out, env: {} });
      stage.reserve();
      out.reset();

      stage.paint(band(29, (i) => `${'x'.repeat(400)} ${i}`), { row: 28, col: 0 });

      // Reconstruct the rows the diff actually wrote.
      for (const chunk of out.chunks) {
        if (!chunk.startsWith('\r')) continue;
        const row = chunk.replace(/^\r/, '').replace(/\x1b\[K$/, '');
        assert.ok(visibleWidth(row) <= columns - 1,
          `a row of ${visibleWidth(row)} columns at width ${columns} would wrap and desynchronise the diff`);
      }
    });
  }

  test('an embedded newline in a caller row cannot scroll the terminal', () => {
    const out = sink({ rows: 30 });
    const stage = new Stage({ out, env: {} });
    stage.reserve();
    out.reset();
    stage.paint(['first\nsecond', ...band(28)], { row: 28, col: 0 });
    assert.ok(!out.text().includes('\n'));
  });

  test('short and long caller input is padded and cut to exactly the band', () => {
    const out = sink({ rows: 30 });
    const stage = new Stage({ out, env: {} });
    stage.reserve();
    assert.equal(stage.normalize(['only one']).length, 29);
    assert.equal(stage.normalize(band(200)).length, 29);
  });
});

// ---------------------------------------------------------------------------

describe('resize re-reserves rather than guessing', () => {
  test('growing and shrinking both end with a correctly sized band', () => {
    const out = sink({ rows: 30 });
    const stage = new Stage({ out, env: {} });
    stage.reserve();
    assert.equal(stage.height, 29);

    out.rows = 50;
    assert.equal(stage.resize(), true);
    assert.equal(stage.height, 49);
    assert.equal(stage.reserved, true);

    out.rows = 20;
    stage.resize();
    assert.equal(stage.height, 19);
    assert.equal(stage.reserved, true);

    // Below the floor the stage refuses and the caller falls back.
    out.rows = 10;
    assert.equal(stage.resize(), false);
    assert.equal(stage.reserved, false);
  });

  test('a resize never emits a takeover escape either', () => {
    const out = sink({ rows: 30 });
    const stage = new Stage({ out, env: {} });
    stage.reserve();
    out.reset();
    out.rows = 45;
    stage.resize();
    const text = out.text();
    assert.ok(!text.includes('\x1b[2J') && !text.includes('\x1b[?1049h'));
  });
});

// ---------------------------------------------------------------------------

describe('the transcript is a model of frames, not a log of rows', () => {
  test('rows and markers line up', () => {
    const t = new Transcript();
    t.append({ kind: 'user', produce: () => ['you: hello'] });
    t.append({ kind: 'assistant', produce: () => ['causyne: hi', 'second line'] });

    assert.deepEqual(t.rows(80), ['you: hello', 'causyne: hi', 'second line']);
    assert.deepEqual(t.markers(80).map((m) => [m.kind, m.row]),
      [['user', 0], ['assistant', 1]]);
    assert.equal(t.height(80), 3);
  });

  test('a width change re-renders; an unchanged width does not', () => {
    let calls = 0;
    const t = new Transcript();
    t.append({ kind: 'notice', produce: (width) => { calls++; return [`w=${width}`]; } });

    assert.deepEqual(t.rows(80), ['w=80']);
    assert.equal(calls, 1);
    t.rows(80); t.rows(80);
    assert.equal(calls, 1, 'memoised on (width, revision)');

    // This is the whole reason frames are stored instead of rows: opencode's
    // split-footer mode cannot do this and has to re-emit the entire transcript
    // on every resize.
    assert.deepEqual(t.rows(120), ['w=120']);
    assert.equal(calls, 2);
  });

  test('a frame whose formatter throws costs one frame, not the session', () => {
    const t = new Transcript();
    t.append({ kind: 'notice', produce: () => ['before'] });
    t.append({ kind: 'error', produce: () => { throw new Error('boom'); } });
    t.append({ kind: 'notice', produce: () => ['after'] });
    assert.deepEqual(t.rows(80), ['before', 'after']);
    assert.equal(t.markers(80).length, 3, 'the frame stays, so the rail stays stable');
  });

  test('eviction hands rows to a sink instead of dropping them', () => {
    const evicted = [];
    const t = new Transcript({ maxFrames: 3, onEvict: (rows) => evicted.push(...rows) });
    for (let i = 0; i < 6; i++) t.append({ kind: 'notice', produce: () => [`f${i}`] });

    assert.equal(t.length, 3);
    assert.deepEqual(t.rows(80), ['f3', 'f4', 'f5']);
    assert.deepEqual(evicted, ['f0', 'f1', 'f2'],
      'overflow becomes real scrollback — eviction is not deletion');
    assert.equal(t.evictedFrames, 3);
  });

  test('a newline inside a produced row is split, never carried', () => {
    const t = new Transcript();
    t.append({ kind: 'notice', produce: () => ['one\ntwo'] });
    assert.deepEqual(t.rows(80), ['one', 'two']);
  });

  test('slice and snapshot are what the viewport and the exit path ask for', () => {
    const t = new Transcript();
    for (let i = 0; i < 10; i++) t.append({ kind: 'notice', produce: () => [`r${i}`] });
    assert.deepEqual(t.slice(80, 3, 4), ['r3', 'r4', 'r5', 'r6']);
    assert.deepEqual(t.slice(80, 8, 100), ['r8', 'r9'], 'clamped, not thrown');
    assert.equal(t.snapshot(80).length, 10);
  });
});

// ---------------------------------------------------------------------------

describe('ChatRenderer produces frames without changing what scrollback mode writes', () => {
  test('with no transcript attached, every byte takes the path it always did', () => {
    const out = sink();
    const renderer = new ChatRenderer({ out });
    renderer.handle({ type: 'agent_message', content: 'hello there' });
    assert.match(out.text(), /hello there/);
    assert.equal(renderer.transcript, null);
  });

  test('with a transcript attached, nothing reaches the terminal', () => {
    const out = sink();
    const transcript = new Transcript();
    const renderer = new ChatRenderer({ out, transcript });

    renderer.handle({ type: 'agent_message', content: 'hello there' });
    renderer.handle({ type: 'step_start', tool: 'read_file', args: { path: 'a.js' } });
    renderer.handle({ type: 'step_complete', result: { success: true } });

    assert.equal(out.text(), '', 'the model owns the rows now, not stdout');
    assert.equal(transcript.length, 3);
    assert.deepEqual(transcript.markers(80).map((m) => m.kind), ['assistant', 'step', 'result']);
    assert.match(stripAnsi(transcript.rows(80).join('\n')), /hello there/);
  });

  test('a reflow re-renders at the new width', () => {
    const transcript = new Transcript();
    const renderer = new ChatRenderer({ out: sink(), transcript });
    const long = 'ratatouille '.repeat(40);
    renderer.handle({ type: 'agent_message', content: long });

    const narrow = transcript.rows(50);
    const wide = transcript.rows(120);
    assert.ok(narrow.length > wide.length,
      'the same frame wraps to more rows on a narrower terminal — this is what row storage cannot do');
    for (const row of narrow) assert.ok(visibleWidth(row) <= 50, 'reflow respects the new width');
  });

  test('a step number is frozen at emit time, not re-read on reflow', () => {
    // The contract the Transcript rests on: a producer is a pure function of
    // width. If onStepStart read this.stepCount from inside the closure, every
    // step would renumber itself to the latest count the first time the window
    // was resized.
    const transcript = new Transcript();
    const renderer = new ChatRenderer({ out: sink(), transcript });
    for (let i = 0; i < 3; i++) {
      renderer.handle({ type: 'step_start', tool: 'read_file', args: { path: `f${i}.js` } });
    }
    const before = transcript.rows(100).map(stripAnsi);
    renderer.stepCount = 99;
    const after = transcript.rows(60).map(stripAnsi);

    assert.ok(before.some((r) => r.includes('01')) && before.some((r) => r.includes('03')));
    assert.ok(after.some((r) => r.includes('01')), 'step 01 is still step 01 after a reflow');
    assert.ok(!after.some((r) => r.includes('99')), 'no frame re-reads live renderer state');
  });

  test('a turn footer reports the turn it closed, not the current one', () => {
    const transcript = new Transcript();
    const renderer = new ChatRenderer({ out: sink(), transcript });
    renderer.stepCount = 4;
    renderer.turnFooter(5200);
    renderer.resetTurn();

    const rows = transcript.rows(100).map(stripAnsi).join('\n');
    assert.match(rows, /4 steps/, 'resolved at emit time, so resetTurn cannot rewrite history');
  });

  test('ctrl+o twice, on two different outputs, leaves two different frames', () => {
    const transcript = new Transcript();
    const renderer = new ChatRenderer({ out: sink(), transcript });

    renderer.handle({ type: 'step_complete', result: { success: true, output: 'FIRST PAYLOAD' } });
    renderer.expandLastOutput();
    renderer.handle({ type: 'step_complete', result: { success: true, output: 'SECOND PAYLOAD' } });
    renderer.expandLastOutput();

    const text = stripAnsi(transcript.rows(100).join('\n'));
    assert.match(text, /FIRST PAYLOAD/);
    assert.match(text, /SECOND PAYLOAD/);

    // And it stays true after a reflow — the failure mode being guarded is a
    // re-render re-pointing "the last output" at a payload from ten turns ago.
    const reflowed = stripAnsi(transcript.rows(70).join('\n'));
    assert.match(reflowed, /FIRST PAYLOAD/);
    assert.match(reflowed, /SECOND PAYLOAD/);
  });

  test('an approval records what was consented to, not what the file became', () => {
    // approvalDiff() reads from disk. If it ran from inside the producer, a
    // resize after the write was approved and applied would re-read the file
    // and show the user a diff of the change against itself — a record of
    // consent silently rewritten by the thing it authorised.
    const file = path.join(os.tmpdir(), `causyne-stage-${process.pid}-${Math.random()}.txt`);
    fs.writeFileSync(file, 'original line\n');

    const transcript = new Transcript();
    const renderer = new ChatRenderer({ out: sink(), transcript });
    renderer.handle({
      type: 'approval_request',
      toolCallId: 'call-1',
      tool: 'fs_write',
      risk: 'dangerous',
      args: { path: file, content: 'replacement line\n' }
    });

    const atEmit = stripAnsi(transcript.rows(100).join('\n'));
    assert.match(atEmit, /original line/, 'the diff was captured while consent was being asked for');

    // The write happens, then the terminal is resized.
    fs.writeFileSync(file, 'replacement line\n');
    const afterReflow = stripAnsi(transcript.rows(70).join('\n'));
    assert.match(afterReflow, /original line/,
      'the frozen diff survives the reflow — a consent record may not be re-derived from the world');

    fs.rmSync(file, { force: true });
  });

  test('usage_update still prints nothing and still feeds the status line', () => {
    const transcript = new Transcript();
    const renderer = new ChatRenderer({ out: sink(), transcript });
    renderer.handle({ type: 'usage_update', usage: { totalTokens: 1200 }, costUsd: 0.02 });
    assert.equal(transcript.length, 0, 'a counter must not interleave itself into the transcript');
  });
});

// ---------------------------------------------------------------------------

describe('the two halves compose', () => {
  test('a transcript renders into a band without wrapping it', () => {
    const out = sink({ columns: 90, rows: 30 });
    const transcript = new Transcript();
    const renderer = new ChatRenderer({ out, transcript, quietStatus: true });
    for (let i = 0; i < 20; i++) {
      renderer.handle({ type: 'agent_message', content: `message ${i} ${'word '.repeat(20)}` });
    }

    const stage = new Stage({ out, env: {} });
    stage.reserve();
    out.reset();

    // The viewport slice the Stage will eventually own: the tail of the model.
    const viewportRows = 25;
    const all = transcript.rows(90);
    const window = all.slice(Math.max(0, all.length - viewportRows));
    const painted = stage.paint([...window, ...Array(29 - window.length).fill('')], { row: 28, col: 0 });

    assert.ok(painted > 0);
    const text = out.text();
    assert.ok(!text.includes('\n'), 'still no newline');
    for (const chunk of out.chunks) {
      if (!chunk.startsWith('\r')) continue;
      const row = chunk.replace(/^\r/, '').replace(/\x1b\[K$/, '');
      assert.ok(visibleWidth(row) <= 89);
    }
  });

  test('eviction during a live session flushes through the stage to scrollback', () => {
    const out = sink({ columns: 90, rows: 30 });
    const stage = new Stage({ out, env: {} });
    stage.reserve();

    const flushed = [];
    const transcript = new Transcript({
      maxFrames: 5,
      onEvict: (rows) => { flushed.push(...rows); stage.invalidate(); }
    });
    const renderer = new ChatRenderer({ out, transcript, quietStatus: true });
    for (let i = 0; i < 12; i++) renderer.handle({ type: 'notice', message: `note ${i}` });

    assert.equal(transcript.length, 5);
    assert.ok(flushed.length > 0, 'the overflow is handed somewhere, not dropped');
    assert.match(stripAnsi(flushed.join('\n')), /note 0/);
  });
});
