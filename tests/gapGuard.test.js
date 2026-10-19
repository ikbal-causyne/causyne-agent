// UX-03 — the first paint must fit the screen.
//
// THE GUARD THAT DID NOT EXIST, AND WHY THAT MATTERED.
//
// UX-01 originally addressed a visible terminal gap.
// Its checks are all about ESCAPE BYTES: no \x1b[2J, no \x1b[?1049h, the
// wordmark first on stdout, a source scan over src/. Every single one of them
// passed while the reference terminal still looked like this:
//
//     banner (12 rows) + band (77 rows) = 89 rows on a 78-row terminal
//     → the wordmark scrolled 11 rows out of sight before he typed anything
//     → 73 of the 77 claimed rows were empty
//
// A rule written against a MECHANISM cannot see a defect in the PICTURE. This
// file checks the picture, by measurement.
//
// It is deliberately NOT a pty test, which is a departure from the plan's
// wording. The numbers come from our own byte stream, so a pty adds nothing —
// and a test that shells out to script(1) would be a BSD/GNU argument mismatch
// and dead on Windows. Synthetic
// sink, real code path, real geometry.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { ChatRenderer } from '../src/tui/chatRenderer.js';
import { ChatPrompt } from '../src/tui/prompt.js';
import { StageSurface } from '../src/tui/stageSurface.js';
import { stageHeight } from '../src/tui/stage.js';
import { visibleWidth } from '../src/tui/text.js';

// Reference geometry from the original regression. It stays in the suite so
// this terminal size cannot regress unnoticed.
const REFERENCE_TERMINAL = { columns: 156, rows: 78 };

const SESSION = {
  version: 'v1.9.19', provider: 'Gemini', model: 'gemini-3.1-pro',
  autonomyMode: 'B', tier: 'fast', relayEnabled: true, commandCount: 15,
  workspace: '/Users/Shared, /home, ~/Desktop, ~/Documents, ~/Downloads, ~/Causyne',
  cwd: '/Users/example', contextLimit: 184000
};

/**
 * Drive the real startup path and count what reached the terminal.
 *
 * The order matters and mirrors chatMode(): the session header is printed to
 * stdout FIRST — that is what keeps the wordmark the first thing written, per
 * UX-01 — and only then is the band claimed beneath it. Measuring the band
 * alone would have missed the whole bug, which was the SUM of the two.
 */
function measureStartup({ columns, rows }) {
  const chunks = [];
  let phase = 'banner';
  const counts = { banner: 0, reserve: 0, draw: 0 };

  const out = {
    columns, rows, isTTY: true,
    write(text) {
      chunks.push(text);
      counts[phase] += (String(text).match(/\n/g) || []).length;
      return true;
    },
    on() {}, removeListener() {}
  };

  const renderer = new ChatRenderer({ out });
  // The banner reports the width it used; chatMode hands that to the surface so
  // the opening composition lines up with it. Mirrored here exactly, because a
  // guard that drives a different path from production guards nothing.
  const bannerWidth = renderer.sessionHeader({ ...SESSION });

  phase = 'reserve';
  const surface = new StageSurface({ out, env: {}, openingWidth: bannerWidth });
  const opened = surface.open();

  phase = 'draw';
  let prompt = null;
  if (opened) {
    renderer.transcript = surface.transcript;
    prompt = new ChatPrompt({
      out, surface,
      input: { isTTY: true, setRawMode() {}, resume() {}, pause() {}, on() {}, off() {} }
    });
    prompt.attachSurface(surface);
    prompt.attach(renderer);
    prompt.active = true;
    prompt.draw();
  }

  const band = opened ? surface.stage.prev : [];
  const firstContent = band.findIndex((row) => String(row).trim() !== '');

  return {
    opened,
    bannerRows: counts.banner,
    reserveRows: counts.reserve,
    drawRows: counts.draw,
    totalRows: counts.banner + counts.reserve + counts.draw,
    bannerWidth,
    bandHeight: opened ? surface.stage.height : 0,
    ceiling: opened ? surface.stage.maxHeight : 0,
    blankRowsAtTopOfBand: firstContent < 0 ? band.length : firstContent,
    surface, prompt, renderer,
    text: () => chunks.join('')
  };
}

// ---------------------------------------------------------------------------

describe('UX-03 — the first screen fits, at the reference terminal size', () => {
  test('startup emits fewer rows than the terminal has', () => {
    const m = measureStartup(REFERENCE_TERMINAL);
    assert.equal(m.opened, true);
    assert.ok(m.totalRows < REFERENCE_TERMINAL.rows,
      `${m.totalRows} rows onto a ${REFERENCE_TERMINAL.rows}-row screen: ` +
      `banner ${m.bannerRows} + reserve ${m.reserveRows} + draw ${m.drawRows}. ` +
      'This is exactly the arithmetic that scrolled the wordmark out of sight.');
  });

  test('the band claims nothing it cannot fill', () => {
    const m = measureStartup(REFERENCE_TERMINAL);
    assert.equal(m.blankRowsAtTopOfBand, 0,
      `${m.blankRowsAtTopOfBand} blank rows above the first content — it was 73 of 77 before`);
    assert.ok(m.bandHeight < m.ceiling,
      `an empty session took ${m.bandHeight} of its ${m.ceiling}-row ceiling`);
  });

  test('the wordmark is still the first thing written', () => {
    // UX-01's check, restated here so the two cannot drift apart: the fix for
    // the gap must not be "print the banner later".
    const m = measureStartup(REFERENCE_TERMINAL);
    const plain = m.text().replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    const art = plain.search(/[█C]/);
    assert.ok(art >= 0, 'the wordmark must be written');
    assert.equal(plain.slice(0, art).trim(), '', 'nothing may be printed above it');
  });
});

describe('UX-03 — and at every supported geometry', () => {
  const WIDTHS = [60, 80, 102, 120, 156, 200];
  const HEIGHTS = [17, 20, 24, 40, 60, 78, 120];

  for (const rows of HEIGHTS) {
    test(`nothing overflows a ${rows}-row terminal`, () => {
      for (const columns of WIDTHS) {
        const m = measureStartup({ columns, rows });
        if (!m.opened) continue;   // too short for a stage: the scrollback renderer, unchanged
        assert.ok(m.totalRows < rows,
          `${columns}x${rows}: ${m.totalRows} rows emitted ` +
          `(banner ${m.bannerRows} + reserve ${m.reserveRows} + draw ${m.drawRows})`);
        assert.equal(m.blankRowsAtTopOfBand, 0, `${columns}x${rows}: void above the content`);
      }
    });
  }

  test('a terminal too short for a stage falls back rather than overflowing', () => {
    for (const rows of [8, 12, 14, 16]) {
      const m = measureStartup({ columns: 100, rows });
      assert.equal(stageHeight({ columns: 100, rows }, {}), 0);
      assert.equal(m.opened, false, `${rows} rows must get the scrollback renderer, not a cramped band`);
    }
  });
});

describe('UX-03 — the band still fills when there is something to fill it with', () => {
  test('a long session reaches the ceiling and stops', () => {
    const m = measureStartup(REFERENCE_TERMINAL);
    for (let i = 0; i < 200; i++) {
      m.renderer.handle({ type: 'agent_message', content: `answer ${i}` });
    }
    m.prompt.draw();
    assert.equal(m.surface.stage.height, m.ceiling, 'it grew all the way');
    assert.ok(m.surface.stage.height <= REFERENCE_TERMINAL.rows - 1, 'and never past the seam row');
  });

  test('growing never leaves a void either', () => {
    const m = measureStartup(REFERENCE_TERMINAL);
    for (let n = 1; n <= 40; n++) {
      m.renderer.handle({ type: 'agent_message', content: `answer ${n}` });
      m.prompt.draw();
      const band = m.surface.stage.prev;
      const firstContent = band.findIndex((row) => String(row).trim() !== '');
      assert.equal(firstContent, 0,
        `after ${n} answers the band had ${firstContent} blank rows above its content`);
    }
  });

  test('and the transcript is what fills it, not padding', () => {
    const m = measureStartup(REFERENCE_TERMINAL);
    for (let i = 0; i < 6; i++) m.renderer.handle({ type: 'agent_message', content: `answer ${i}` });
    m.prompt.draw();

    const contentWidth = m.surface.viewport.width;
    const promptRows = m.surface.stage.height - m.surface.viewport.height;
    assert.equal(
      m.surface.stage.height,
      Math.min(m.ceiling, promptRows + m.surface.transcript.height(contentWidth)),
      'the band is exactly the prompt plus the transcript, capped at the ceiling'
    );
  });
});


// ---------------------------------------------------------------------------

describe('the opening composition — one panel, not a bar across a void', () => {
  const widthOf = (rows) => Math.max(0, ...rows.map((row) => visibleWidth(row)));

  test('the input box is laid out to the banner, not to the terminal', () => {
    // What made the first screen read as unfinished even after the void was
    // gone: the banner's text stops around 122 columns and the filled input
    // surface stretched all 156, so the two read as unrelated objects.
    const m = measureStartup(REFERENCE_TERMINAL);
    assert.ok(m.bannerWidth > 0, 'sessionHeader must report the width it used');
    assert.ok(widthOf(m.surface.stage.prev) <= m.bannerWidth,
      `the box came out ${widthOf(m.surface.stage.prev)} wide beside a ${m.bannerWidth}-wide banner`);
    assert.ok(widthOf(m.surface.stage.prev) >= m.bannerWidth - 4,
      'and not so much narrower that it reads as a different object');
  });

  test('the cap lifts the moment there is a session', () => {
    const m = measureStartup(REFERENCE_TERMINAL);
    assert.equal(m.surface.composeWidth(), m.bannerWidth);

    m.renderer.handle({ type: 'agent_message', content: 'the session has started' });
    m.prompt.draw();

    assert.equal(m.surface.composeWidth(), REFERENCE_TERMINAL.columns,
      'the session input box keeps filling the window — the established layout invariant');
    assert.ok(widthOf(m.surface.stage.prev) > m.bannerWidth,
      'and it visibly widens rather than staying in the opening measure');
  });

  test('the banner itself is never the thing that gets narrowed', () => {
    // Measured: composing the banner at 117 columns already truncates the
    // workspace list past ~/Causyne — the directory the user is working in. The
    // banner is adaptive text that shows more when given more; the box is a
    // filled surface whose edge-to-edge bar is what looked wrong.
    const wide = new ChatRenderer({ out: { columns: 156, write: () => true } });
    const narrow = new ChatRenderer({ out: { columns: 100, write: () => true } });
    assert.ok(wide.sessionHeader({ ...SESSION }) > narrow.sessionHeader({ ...SESSION }),
      'the banner uses the room it is given, so it must be given the whole terminal');
  });

  test('the opening measure never exceeds the terminal', () => {
    for (const columns of [60, 80, 100, 120, 156, 200]) {
      const m = measureStartup({ columns, rows: 40 });
      assert.ok(m.surface.composeWidth() <= columns, `${columns}: asked for more than it has`);
      for (const row of m.surface.stage.prev) {
        assert.ok(visibleWidth(row) <= columns - 1, `${columns}: a row came back ${visibleWidth(row)} wide`);
      }
    }
  });

  test('the opening measure belongs to THE opening, not to every empty moment', () => {
    // /print and ctrl+L empty the transcript. Keying the measure on emptiness
    // narrowed the input box back to the banner's width long after the banner
    // had scrolled out of view — the box visibly shrinking for a reason the user
    // cannot see. Found by asking what happens after /print, not by a failing
    // test; the guard exists so nobody has to ask again.
    const m = measureStartup(REFERENCE_TERMINAL);
    assert.equal(m.surface.composeWidth(), m.bannerWidth);

    m.renderer.handle({ type: 'agent_message', content: 'a session happens' });
    assert.equal(m.surface.composeWidth(), REFERENCE_TERMINAL.columns);

    m.surface.flushAndClear();
    assert.equal(m.surface.transcript.length, 0, 'the transcript really is empty again');
    assert.equal(m.surface.composeWidth(), REFERENCE_TERMINAL.columns,
      'and the box stays where it is — there is no banner up there to line up with any more');
  });

  test('with nobody measuring the banner it still behaves', () => {
    const out = { columns: 156, rows: 40, isTTY: true, write: () => true, on() {}, removeListener() {} };
    const surface = new StageSurface({ out, env: {} });
    surface.open();
    const fallback = surface.composeWidth();
    assert.ok(fallback > 20 && fallback <= 156, `fallback measure was ${fallback}`);

    surface.transcript.append({ kind: 'notice', produce: () => ['x'] });
    assert.equal(surface.composeWidth(), 156, 'and it still lifts once there is a session');
  });
});
