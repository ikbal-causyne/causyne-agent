// The rail, and the restore points nobody was told about.
//
// Two halves, both of which existed as capability and neither of which reached
// the user:
//
//  * `captureBeforeMutation()` ran on every mutating tool call, returned the ids
//    of the restore points it had just written, and the loop DROPPED them
//    (agentLoop.js:1569). Checkpointing has been on by default the whole time
//    (`CAUSYNE_CHECKPOINTS !== '0'`) and `/undo` has been sitting there with
//    nothing pointing at it.
//  * The Transcript has known where every frame starts since phase 0, and
//    nothing read the index.
//
// The rail is proportional on purpose: a per-row gutter would only mark what is
// already on screen, which tells you nothing you cannot see. Mapping the WHOLE
// transcript onto one column is what makes a glance answer "how far in am I, and
// is there anything back there worth going to". opencode has no equivalent — its
// scrollbar reports position and nothing about content.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { StageSurface } from '../src/tui/stageSurface.js';
import { ChatPrompt } from '../src/tui/prompt.js';
import { ChatRenderer } from '../src/tui/chatRenderer.js';
import { PromptHistory } from '../src/tui/history.js';
import { visibleWidth, stripAnsi } from '../src/tui/text.js';
import { GLYPHS } from '../src/tui/theme.js';
import { execFileSync } from 'node:child_process';

// The glyph set is chosen at import from the TTY, and `node --test` has none —
// so HAS_UNICODE is false here and every mark is its ASCII fallback. Asserting
// the Unicode character directly is a test that only passes in a terminal.

const here = path.dirname(fileURLToPath(import.meta.url));

function sink({ columns = 100, rows = 40, isTTY = true } = {}) {
  const chunks = [];
  return {
    columns, rows, isTTY,
    write(text) { chunks.push(text); return true; },
    on() {}, removeListener() {},
    text: () => chunks.join(''), reset: () => { chunks.length = 0; }, chunks
  };
}

function fakeInput() {
  return { isTTY: true, setRawMode() {}, resume() {}, pause() {}, on() {}, off() {} };
}

function surfaceOn({ columns = 100, rows = 30, env = {} } = {}) {
  const out = sink({ columns, rows });
  const surface = new StageSurface({ out, env });
  surface.open();
  return { surface, out };
}

/** The rail column of each viewport row, as plain characters. */
function railColumn(surface, promptRows = ['status']) {
  surface.present(promptRows, { row: 0, col: 0 });
  const band = surface.stage.prev;
  const viewportRows = band.length - promptRows.length;
  return band.slice(0, viewportRows).map((row) => stripAnsi(row).slice(-1));
}

// ---------------------------------------------------------------------------

describe('the rail is one column and never costs a wrap', () => {
  test('it sits at the right edge of every viewport row', () => {
    const { surface } = surfaceOn();
    for (let i = 0; i < 200; i++) {
      surface.transcript.append({ kind: 'step', produce: () => [`step ${i}`] });
    }
    const rail = railColumn(surface);
    assert.equal(rail.length, 29 - 1, 'one rail cell per viewport row');
    assert.ok(rail.some((c) => c.trim()), 'and it actually has marks on it');
  });

  test('every band row still fits width - 1 at every width', () => {
    // The invariant the whole Stage rests on. The rail takes columns away from
    // the transcript, so getting the arithmetic wrong here is exactly how a row
    // would come out one column too long and desynchronise the diff.
    for (const columns of [60, 80, 102, 120, 200]) {
      const { surface } = surfaceOn({ columns });
      for (let i = 0; i < 120; i++) {
        surface.transcript.append({ kind: 'assistant', produce: (w) => ['x'.repeat(w)] });
      }
      surface.present(['status row'], { row: 0, col: 0 });
      for (const row of surface.stage.prev) {
        assert.ok(visibleWidth(row) <= columns - 1,
          `a ${visibleWidth(row)}-column row at width ${columns}`);
      }
    }
  });

  test('a narrow terminal gets its columns back instead of a crowded rail', () => {
    const wide = surfaceOn({ columns: 100 });
    wide.surface.transcript.append({ kind: 'step', produce: () => ['x'] });
    wide.surface.present(['status'], { row: 0, col: 0 });
    // Three, not two: the composed row is contentWidth + air + rail, and the
    // Stage clamps every row to width - 1 so a wrap is impossible.
    assert.equal(wide.surface.viewport.width, 97);

    const narrow = surfaceOn({ columns: 50 });
    narrow.surface.transcript.append({ kind: 'step', produce: () => ['x'] });
    narrow.surface.present(['status'], { row: 0, col: 0 });
    assert.equal(narrow.surface.viewport.width, 50, 'below the threshold the text wins');
  });

  test('CAUSYNE_RAIL=0 turns it off at any width', () => {
    const { surface } = surfaceOn({ columns: 120, env: { CAUSYNE_RAIL: '0' } });
    surface.transcript.append({ kind: 'step', produce: () => ['x'] });
    surface.present(['status'], { row: 0, col: 0 });
    assert.equal(surface.viewport.width, 120);
  });

  test('an empty transcript does not divide by zero', () => {
    const { surface } = surfaceOn();
    assert.doesNotThrow(() => surface.present(['status'], { row: 0, col: 0 }));
  });

  test('nothing to scroll means no thumb at all', () => {
    // Found on a pty: on an empty session the thumb filled the entire column,
    // indicating a position that could not change. A scrollbar whose track is
    // full says the same thing as no scrollbar.
    const { surface } = surfaceOn();
    surface.transcript.append({ kind: 'notice', produce: () => ['just one row'] });
    const rail = railColumn(surface);
    assert.ok(!rail.includes(GLYPHS.vLine), `expected a blank track, got ${JSON.stringify(rail.join(''))}`);
  });
});

// ---------------------------------------------------------------------------

describe('what the rail shows', () => {
  test('the whole session, not just what is on screen', () => {
    // 600 rows into a 28-row viewport. A per-row gutter would mark at most 28
    // frames; this has to reach the ones far above and below.
    const { surface } = surfaceOn();
    for (let i = 0; i < 200; i++) {
      surface.transcript.append({ kind: 'step', produce: () => [`a${i}`, `b${i}`, `c${i}`] });
    }
    // One error, right at the very top of the session.
    surface.transcript.frames[1].kind = 'error';
    surface.transcript.revision++;
    surface.transcript.cache = null;

    surface.viewport.toBottom();
    const rail = railColumn(surface);
    assert.ok(rail.includes(GLYPHS.cross),
      'an error 590 rows above the viewport is still visible on the rail');
  });

  test('the loudest marker in a slot wins', () => {
    // A proportional rail on a long session compresses dozens of frames per
    // row. What you want at a glance is the thing that went wrong, not the
    // forty step rows around it.
    const { surface } = surfaceOn();
    for (let i = 0; i < 300; i++) {
      surface.transcript.append({ kind: 'step', produce: () => [`s${i}`] });
    }
    const before = railColumn(surface).filter((c) => c === GLYPHS.cross).length;
    assert.equal(before, 0);

    surface.transcript.frames[150].kind = 'error';
    surface.transcript.revision++;
    surface.transcript.cache = null;
    assert.equal(railColumn(surface).filter((c) => c === GLYPHS.cross).length, 1,
      'one error among three hundred steps still claims its row');
  });

  test('a restore point is marked, which is the point of marking anything', () => {
    const { surface } = surfaceOn();
    for (let i = 0; i < 100; i++) {
      surface.transcript.append({ kind: 'step', produce: () => [`s${i}`] });
    }
    const plain = railColumn(surface);
    surface.transcript.frames[50].kind = 'checkpoint';
    surface.transcript.revision++;
    surface.transcript.cache = null;
    const marked = railColumn(surface);

    assert.notDeepEqual(marked, plain, 'the rail changed when a restore point appeared');
    assert.ok(marked.includes(GLYPHS.step));
  });

  test('routine markers do not shred the thumb', () => {
    // Found on a real pty, not here: a restore point is taken on every file
    // write, so with the yield threshold set at checkpoints the thumb came out
    // as `▌▌▪▪▪▌` — the position indicator chopped apart by the most routine
    // event there is. Only what is rare AND urgent may claim a row of position.
    const { surface } = surfaceOn();
    for (let i = 0; i < 300; i++) {
      surface.transcript.append({ kind: 'checkpoint', produce: () => [`write ${i}`] });
    }
    surface.viewport.toBottom();
    const rail = railColumn(surface);

    // The thumb is a continuous rule with one dot at its middle, so its rows are
    // adjacent. Unbroken means no gap larger than the single dot.
    const rules = rail.map((c, i) => (c === GLYPHS.vLine ? i : -1)).filter((i) => i >= 0);
    assert.ok(rules.length > 1, 'the thumb is visible at all');
    for (let i = 1; i < rules.length; i++) {
      assert.ok(rules[i] - rules[i - 1] <= 2,
        `the thumb is broken at row ${rules[i]}: ${JSON.stringify(rail.join(''))}`);
    }
  });

  test('the thumb is one line with a single dot at its middle', () => {
    // Two attempts to get here. `▌` per row renders as ragged stubs, because the
    // block glyph does not fill the cell's full height in most terminal fonts.
    // Alternating `│·│·│` fixed the glyph and introduced a worse problem: over a
    // thumb of any length it reads as a long dashed line — the very thing it was
    // meant to stop looking like. One dot at the centre makes even a full-track
    // thumb read as a single object.
    const { surface } = surfaceOn();
    for (let i = 0; i < 12; i++) {
      surface.transcript.append({ kind: 'assistant', produce: () => ['a', 'b', 'c', 'd', 'e'] });
    }
    surface.viewport.toTop();
    const rail = railColumn(surface);

    const thumb = [];
    for (let i = 0; i < rail.length; i++) {
      if (rail[i] === GLYPHS.vLine || (thumb.length > 0 && rail[i] === GLYPHS.dot)) thumb.push(i);
      else if (thumb.length > 0) break;
    }
    assert.ok(thumb.length >= 3, `the thumb was ${thumb.length} rows: ${JSON.stringify(rail.join(''))}`);

    const dots = thumb.filter((i) => rail[i] === GLYPHS.dot);
    assert.equal(dots.length, 1, `exactly one dot, not ${dots.length} — a run of dots is a dashed line`);
    assert.equal(dots[0], thumb[Math.floor(thumb.length / 2)], 'and it sits at the middle');
  });

  test('the thumb is a darker blue than the accent, so it recedes', () => {
    // The rail is orientation, not something you act on. In accent cyan it was
    // the brightest thing on a screen full of prose.
    //
    // This drives the REAL rail in a child with FORCE_COLOR, not the palette.
    // The first version of this test compared the two roles and passed happily
    // with the rail still painted in accent — it asserted that the colour
    // EXISTS, never that anything uses it.
    const script = `
      import { StageSurface } from ${JSON.stringify(path.join(here, '..', 'src/tui/stageSurface.js'))};
      const out = { columns: 100, rows: 30, isTTY: true, write: () => true, on(){}, removeListener(){} };
      const surface = new StageSurface({ out, env: {} });
      surface.open();
      for (let i = 0; i < 12; i++) {
        surface.transcript.append({ kind: 'assistant', produce: () => ['a','b','c','d','e'] });
      }
      surface.viewport.toTop();
      surface.present(['status'], { row: 0, col: 0 });
      const band = surface.stage.prev;
      process.stdout.write(JSON.stringify(band.slice(0, band.length - 1)));
    `;
    const file = path.join(os.tmpdir(), `causyne-rail-colour-${process.pid}.mjs`);
    fs.writeFileSync(file, script);
    const raw = execFileSync(process.execPath, [file], {
      encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '3', NO_COLOR: '', CAUSYNE_NO_COLOR: '0' }
    });
    fs.rmSync(file, { force: true });

    const rows = JSON.parse(raw);
    // The rail is the last thing painted on the row, so the last colour on the
    // row is its colour. Matching "no ESC after" fails here — the cell closes
    // with its own reset.
    const rgbOf = (row) => {
      const all = String(row).match(/38;2;\d+;\d+;\d+m/g);
      if (!all) return null;
      return all[all.length - 1].match(/(\d+);(\d+);(\d+)m$/).slice(1).map(Number);
    };
    const thumb = rows.map(rgbOf).filter(Boolean).filter((c) => c[2] > c[0] && c[2] > c[1]);
    assert.ok(thumb.length > 0, 'no blue rail cell was painted at all');

    const [r, g, b] = thumb[0];
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    // The accent it must not be borrowing.
    const ACCENT_LUMINANCE = 0.2126 * 96 + 0.7152 * 205 + 0.0722 * 255;
    assert.ok(luminance < ACCENT_LUMINANCE,
      `the rail is painted rgb(${r},${g},${b}), no darker than the accent it should have stopped using`);
  });
  test('an error still claims its row even inside the thumb', () => {
    const { surface } = surfaceOn();
    for (let i = 0; i < 40; i++) {
      surface.transcript.append({ kind: 'notice', produce: () => [`n${i}`] });
    }
    surface.transcript.frames[38].kind = 'error';
    surface.transcript.revision++;
    surface.transcript.cache = null;
    surface.viewport.toBottom();
    assert.ok(railColumn(surface).includes(GLYPHS.cross),
      'position is worth less than a failure the user has not seen');
  });

  test('the thumb says where you are, and moves when you scroll', () => {
    const { surface } = surfaceOn();
    for (let i = 0; i < 400; i++) {
      surface.transcript.append({ kind: 'notice', produce: () => [`row ${i}`] });
    }
    surface.viewport.toBottom();
    const atBottom = railColumn(surface);
    surface.viewport.toTop();
    const atTop = railColumn(surface);

    assert.notDeepEqual(atTop, atBottom, 'position is legible on the rail');
    const thumbAt = (rail) => rail.findIndex((c) => c === GLYPHS.vLine);
    assert.ok(thumbAt(atTop) < thumbAt(atBottom), 'and it is where you actually are');
  });
});

// ---------------------------------------------------------------------------

describe('jumping by structure instead of by rows', () => {
  function host({ columns = 100, rows = 30 } = {}) {
    const { surface, out } = surfaceOn({ columns, rows });
    const file = path.join(os.tmpdir(), `causyne-rail-${process.pid}-${Math.random()}`);
    const prompt = new ChatPrompt({
      input: fakeInput(), out, surface, history: new PromptHistory({ file })
    });
    prompt.attachSurface(surface);
    prompt.active = true;
    return { prompt, surface };
  }

  function populate(transcript) {
    for (let turn = 0; turn < 4; turn++) {
      transcript.append({ kind: 'user', produce: () => [`ask ${turn}`, ''] });
      for (let s = 0; s < 5; s++) {
        transcript.append({ kind: 'step', produce: () => [`turn ${turn} step ${s}`, ''] });
      }
      transcript.append({ kind: 'turn', produce: () => [`done ${turn}`, ''] });
    }
  }

  test('alt+. and alt+, walk tool calls', () => {
    const { prompt, surface } = host();
    populate(surface.transcript);
    prompt.draw();
    surface.viewport.toTop();

    const steps = surface.transcript.markers(surface.viewport.width)
      .filter((m) => m.kind === 'step').map((m) => m.row);

    prompt.handleKey({ name: '.', alt: true });
    assert.equal(surface.viewport.scrollTop, steps[0]);
    prompt.handleKey({ name: '.', alt: true });
    assert.equal(surface.viewport.scrollTop, steps[1]);
    prompt.handleKey({ name: ',', alt: true });
    assert.equal(surface.viewport.scrollTop, steps[0]);
  });

  test('alt+> and alt+< skip a whole exchange at a time', () => {
    const { prompt, surface } = host();
    populate(surface.transcript);
    prompt.draw();
    surface.viewport.toTop();

    prompt.handleKey({ name: '>', alt: true });
    const first = surface.viewport.scrollTop;
    prompt.handleKey({ name: '>', alt: true });
    const second = surface.viewport.scrollTop;

    // Five step frames and a turn footer sit between each pair of questions; an
    // exchange jump must clear all of them rather than landing on the next
    // marker of any kind.
    assert.ok(second - first >= 12, `jumped only ${second - first} rows — that is a step, not an exchange`);
    prompt.handleKey({ name: '<', alt: true });
    assert.equal(surface.viewport.scrollTop, first);
  });

  test('the same keys unmodified are still typed, not swallowed', () => {
    // The reason these are alt-modified at all: a bare bracket or comma is a
    // character the user is entitled to type. (The plan's `[`/`]` could not be
    // bound even with alt — ESC [ IS the CSI introducer, so alt+[ is
    // indistinguishable from the start of an escape sequence.)
    const { prompt } = host();
    prompt.handleKey({ name: 'char', text: ',' });
    prompt.handleKey({ name: 'char', text: '.' });
    prompt.handleKey({ name: 'char', text: '<' });
    assert.equal(prompt.editor.getText(), ',.<');
  });

  test('jumping stops at the ends rather than running off them', () => {
    const { prompt, surface } = host();
    populate(surface.transcript);
    prompt.draw();

    surface.viewport.toTop();
    for (let i = 0; i < 50; i++) prompt.handleKey({ name: ',', alt: true });
    assert.equal(surface.viewport.scrollTop, 0);

    for (let i = 0; i < 50; i++) prompt.handleKey({ name: '.', alt: true });
    assert.equal(surface.viewport.scrollTop, surface.viewport.maxScrollTop());
    assert.equal(surface.viewport.following, true, 'running off the end resumes following');
  });
});

// ---------------------------------------------------------------------------

describe('restore points are announced', () => {
  test('the loop no longer drops what captureBeforeMutation returns', () => {
    const source = fs.readFileSync(path.join(here, '..', 'src', 'agentLoop.js'), 'utf8');
    const code = source.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert.match(code, /const restorePoints = captureBeforeMutation\(/,
      'the ids were being discarded, which is why /undo had nothing pointing at it');
    assert.match(code, /type: 'checkpoint'/);
  });

  test('the renderer shows it as part of the step, not as a new event', () => {
    const written = [];
    const renderer = new ChatRenderer({ out: { columns: 90, write: (t) => written.push(t) } });
    renderer.handle({ type: 'step_start', tool: 'fs_write', args: { path: '/tmp/a.js' } });
    renderer.handle({ type: 'checkpoint', count: 1, tool: 'fs_write', path: '/tmp/a.js', step: 1 });
    renderer.handle({ type: 'step_complete', result: { success: true } });

    const rows = stripAnsi(written.join('')).split('\n').filter(Boolean);
    const at = rows.findIndex((r) => r.includes('restore point'));
    assert.ok(at > 0, 'it was rendered');
    assert.match(rows[at], /^ {5}/, 'indented to the result gutter, so it reads as part of the step');
    assert.match(rows[at], /a\.js/, 'and it names what can be rolled back');
  });

  test('it is its own frame kind, so the rail can find it', () => {
    const { surface } = surfaceOn();
    const renderer = new ChatRenderer({ out: sink(), transcript: surface.transcript });
    renderer.handle({ type: 'checkpoint', count: 2, tool: 'fs_edit', path: null, step: 3 });
    assert.deepEqual(surface.transcript.markers(90).map((m) => m.kind), ['checkpoint']);
    assert.match(stripAnsi(surface.transcript.rows(90).join('')), /2 files/,
      'with no path it still says how much is covered');
  });
});
