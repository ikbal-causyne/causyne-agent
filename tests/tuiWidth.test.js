// The live region may never wrap.
//
// ChatPrompt keeps a block of rows at the bottom of the terminal and repaints it
// in place: erase() walks back up `cursorRow` rows and clears with \x1b[J. Both
// numbers are LOGICAL row counts. A row wider than the terminal occupies TWO
// physical rows, so the walk lands one row short and \x1b[J then clears from the
// middle of the block — leaving the rows above it on screen. That is the doubled
// hint row and the trail of half-drawn glyphs in the report.
//
// Two independent defects produced it, and each is guarded here:
//
//  * StatusLine.render() justified against the full `width`, returning a line of
//    exactly `width` columns with no slack at all.
//  * Every glyph in theme.js GLYPHS is East Asian Ambiguous (`·` U+00B7,
//    `▸` U+25B8, `─` U+2500, `…` U+2026). Terminals configured for CJK render
//    them as two columns while visibleWidth() counted one, so a line measured as
//    fitting did not.
//
// The clamp is the invariant that survives both: no row the prompt writes may
// exceed width - 1, whatever the measurement believes.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ChatPrompt, keyHints } from '../src/tui/prompt.js';
import { ChatRenderer } from '../src/tui/chatRenderer.js';
import { StageSurface } from '../src/tui/stageSurface.js';
import { Transcript } from '../src/tui/transcript.js';
import { StatusLine } from '../src/tui/statusLine.js';
import { barBlock, panel, contextMeter } from '../src/tui/block.js';
import { fill } from '../src/tui/theme.js';
import { execFileSync } from 'node:child_process';
import { visibleWidth, stripAnsi, wrapBlock } from '../src/tui/text.js';
import { listCompiledSkills } from '../src/skillsManager.js';

const WIDTHS = [40, 60, 80, 102, 120, 200];
const here = path.dirname(fileURLToPath(import.meta.url));

function drivePrompt(columns, mutate = () => {}) {
  let buffer = '';
  const out = {
    columns,
    write: (text) => { buffer += text; return true; },
    isTTY: true,
    on() {}, removeListener() {}
  };
  const input = {
    isTTY: true, setRawMode() {}, resume() {}, pause() {}, on() {}, off() {}
  };
  const prompt = new ChatPrompt({ out, input, commands: [{ name: 'skills' }] });
  const renderer = new ChatRenderer({ out });
  renderer.status.setSession({
    model: 'gemini-3.5-flash', provider: 'gemini', tier: 'free',
    cwd: '/Users/someone/projects/a-fairly-long-directory-name',
    contextLimit: 184000, relayEnabled: true
  });
  renderer.status.turnTokens = 9200;
  prompt.attach(renderer);
  prompt.active = true;
  mutate(prompt, renderer);
  buffer = '';
  prompt.draw();
  return { prompt, buffer };
}

/** Logical rows, as written — before any terminal has had a chance to wrap them. */
function writtenRows(buffer) {
  return buffer
    .replace(/\x1b\[J/g, '')
    .split('\n')
    .map((row) => row.replace(/\r/g, ''));
}

describe('no row of the live region can wrap', () => {
  for (const columns of WIDTHS) {
    test(`the idle prompt fits ${columns} columns`, () => {
      const { prompt, buffer } = drivePrompt(columns);
      const limit = prompt.width() - 1;
      for (const row of writtenRows(buffer)) {
        assert.ok(visibleWidth(row) <= limit,
          `row of ${visibleWidth(row)} columns exceeds the ${limit} limit: ${JSON.stringify(stripAnsi(row).slice(0, 60))}`);
      }
    });

    test(`a busy prompt with a long status fits ${columns} columns`, () => {
      const { prompt, buffer } = drivePrompt(columns, (p, r) => {
        p.busy = true;
        p.statusMessage = 'reading a rather long file name deep inside the workspace tree';
        r.turnStartedAt = Date.now() - 74300;
        r.stepCount = 12;
      });
      const limit = prompt.width() - 1;
      for (const row of writtenRows(buffer)) {
        assert.ok(visibleWidth(row) <= limit,
          `busy row of ${visibleWidth(row)} columns exceeds the ${limit} limit`);
      }
    });

    test(`the skill picker fits ${columns} columns`, () => {
      const { prompt, buffer } = drivePrompt(columns, (p) => {
        p.browseSkills(listCompiledSkills(), () => {});
      });
      const limit = prompt.width() - 1;
      for (const row of writtenRows(buffer)) {
        assert.ok(visibleWidth(row) <= limit,
          `picker row of ${visibleWidth(row)} columns exceeds the ${limit} limit`);
      }
    });
  }

  test('a deliberately over-wide row is clamped rather than passed through', () => {
    const { prompt } = drivePrompt(80);
    const clamped = prompt.clampRows(['x'.repeat(500)], 80);
    assert.equal(visibleWidth(clamped[0]), 79,
      'clampRows must cut to width - 1, leaving the last column free');
  });

  test('clamping does not leave a colour open at the cut', () => {
    const { prompt } = drivePrompt(40);
    const [row] = prompt.clampRows(['\x1b[31m' + 'x'.repeat(100)], 40);
    assert.ok(row.endsWith('\x1b[0m'), 'a clamped coloured row must close its style');
  });
});

describe('StatusLine reserves a column', () => {
  // The specific regression: gap was computed against `width`, so the justified
  // line came back flush against the right margin with zero slack.
  for (const width of WIDTHS) {
    test(`the working line fits within ${width} - 1`, () => {
      const status = new StatusLine().setSession({
        model: 'gemini-3.5-flash', provider: 'gemini', relayEnabled: true
      });
      status.turnTokens = 128000;
      status.turnCost = 1.2345;
      const line = status.render({
        message: 'reading project files', elapsedMs: 74300, steps: 12, width, spinnerFrame: '*'
      });
      assert.ok(visibleWidth(line) <= width - 1,
        `status line of ${visibleWidth(line)} columns has no slack in ${width}`);
    });

    test(`the idle line fits within ${width} - 1`, () => {
      const status = new StatusLine().setSession({
        model: 'gemini-3.5-flash', cwd: '/Users/someone/projects/deep/nested/path',
        contextLimit: 184000
      });
      status.turnTokens = 9200;
      const line = status.renderIdle({ width, hint: 'ctrl+p commands' });
      assert.ok(visibleWidth(line) <= width - 1,
        `idle line of ${visibleWidth(line)} columns has no slack in ${width}`);
    });
  }
});

describe('block primitives produce exact-width rows', () => {
  test('barBlock pads every row to the block width', () => {
    const rows = barBlock(['short', 'a somewhat longer line of text'], { width: 40 });
    for (const row of rows) {
      assert.equal(visibleWidth(row), 40,
        'a filled block only reads as a surface if every row is the same width');
    }
  });

  test('barBlock clips a row that would overflow', () => {
    const [row] = barBlock(['y'.repeat(200)], { width: 30 });
    assert.equal(visibleWidth(row), 30);
  });

  test('panel rows are exactly the panel width', () => {
    const rows = panel(['  model   gemini', '  scope   ~/x'], { width: 50, title: 'Causyne v1.8.2' });
    for (const row of rows) assert.equal(visibleWidth(row), 50);
  });

  test('contextMeter reports a percentage only when a limit is known', () => {
    assert.equal(contextMeter(9200, 184000), '9.2K (5%)');
    assert.equal(contextMeter(9200, 0), '9.2K', 'an unknown limit must not invent a denominator');
    assert.equal(contextMeter(0, 184000), '', 'no usage yet means no meter');
  });
});

describe('command output is wrapped before it is written', () => {
  test('the real /skills listing fits a 102-column terminal', () => {
    // The measured failure: unwrapped rows reached 195 columns here.
    const lines = [];
    for (const skill of listCompiledSkills()) {
      lines.push(`    ${skill.domain}/${skill.id} — ${skill.description}`);
    }
    const raw = Math.max(...lines.map(visibleWidth));
    assert.ok(raw > 102, 'this fixture is only meaningful while some rows genuinely overflow');

    for (const row of wrapBlock(lines.join('\n'), 102)) {
      assert.ok(visibleWidth(row) <= 102,
        `wrapped row of ${visibleWidth(row)} columns still exceeds 102`);
    }
  });

  test('wrapBlock preserves indentation and hangs continuations', () => {
    const rows = wrapBlock('    indented text that is long enough to need wrapping here', 30);
    assert.ok(rows[0].startsWith('    '), 'the first row keeps its own indentation');
    assert.ok(rows[1].startsWith('      '), 'continuations are indented further so the entry reads as one');
  });
});

describe('the session header hint line fits the terminal', () => {
  // The full list of hints is 145 columns. Printed unconditionally it wrapped on
  // every terminal narrower than that — the very first thing a user sees, broken
  // across two rows mid-word. Fragments drop from the right instead.
  for (const width of WIDTHS) {
    test(`keyHints fits ${width} columns`, () => {
      const line = keyHints(width);
      assert.ok(visibleWidth(line) <= width - 1,
        `keyHints produced ${visibleWidth(line)} columns for a ${width}-column terminal`);
      assert.ok(stripAnsi(line).includes('enter send'),
        'the most important hint must survive every width');
    });
  }

  test('a hint is dropped whole, never truncated mid-key', () => {
    const line = stripAnsi(keyHints(46));
    assert.ok(!line.endsWith('…') && !/\s$/.test(line),
      'a clipped keybinding reads as a bug; drop the fragment instead');
  });
});

describe('resizing the terminal does not stamp copies of the live region', () => {
  // The reported catastrophe: stretching the window filled the screen edge to
  // edge with overlapping copies of the input row.
  //
  // handleResize used to do `drawnRows = 0; cursorRow = 0; scheduleDraw()`.
  // Those two counters are exactly what erase() reads to decide how far to walk
  // back up — so zeroing them FIRST made erase() return immediately and remove
  // nothing, while the caret was still parked mid-block at the text inset from
  // the previous draw. The redraw then wrote a fresh copy from that column, on
  // top of a row that already had content. One stale copy per event, and a drag
  // emits hundreds.
  //
  // The invariant: every block write is preceded by an erase. Measured as a
  // ratio, it is independent of terminal width and of how a reflow lands.

  const EXAMPLE = /try "|type to queue/;

  function resizable(columns = 100) {
    let buffer = '';
    const listeners = {};
    const out = {
      columns,
      write: (text) => { buffer += text; return true; },
      isTTY: true,
      on(event, fn) { (listeners[event] ||= []).push(fn); },
      removeListener(event, fn) {
        listeners[event] = (listeners[event] || []).filter((f) => f !== fn);
      }
    };
    const input = { isTTY: true, setRawMode() {}, resume() {}, pause() {}, on() {}, off() {} };
    const prompt = new ChatPrompt({ out, input, commands: [{ name: 'skills' }] });
    const renderer = new ChatRenderer({ out });
    renderer.status.setSession({ model: 'q', cwd: '/tmp', contextLimit: 1000 });
    prompt.attach(renderer);
    prompt.start();
    return {
      prompt,
      fire: (width) => { out.columns = width; (listeners.resize || []).forEach((fn) => fn()); },
      take: () => { const b = buffer; buffer = ''; return b; },
      stop: () => prompt.stop()
    };
  }

  const countDraws = (text) => (text.match(/try "|type to queue/g) || []).length;
  const countErases = (text) => (text.match(/\x1b\[J/g) || []).length;

  test('a burst of resize events settles into ONE repaint', async () => {
    const t = resizable(100);
    t.prompt.draw();
    t.take();

    for (let width = 100; width < 160; width += 1) t.fire(width);
    // Nothing may be painted while the gesture is still in flight.
    assert.equal(countDraws(t.take()), 0,
      'a drag must not repaint per event — that is what filled the screen');

    await new Promise((r) => setTimeout(r, 120));
    assert.equal(countDraws(t.take()), 1, 'the settled gesture repaints exactly once');
    t.stop();
  });

  test('every repaint is preceded by an erase, at any resize cadence', async () => {
    const t = resizable(100);
    t.prompt.draw();
    t.take();

    let draws = 0;
    let erases = 0;
    for (let step = 0; step < 8; step++) {
      t.fire(100 + step * 5);
      await new Promise((r) => setTimeout(r, 90)); // slower than the settle window
      const text = t.take();
      draws += countDraws(text);
      erases += countErases(text);
    }
    assert.ok(draws > 0, 'this test is only meaningful if repaints actually happened');
    assert.ok(erases >= draws,
      `${draws} repaints against ${erases} erases — an unerased repaint leaves a copy on screen`);
    t.stop();
  });

  test('a resize erases using the geometry it had, not after discarding it', () => {
    const t = resizable(100);
    t.prompt.draw();
    assert.ok(t.prompt.drawnRows > 0, 'the block must be on screen before the resize');
    t.take();

    t.fire(140);
    const text = t.take();
    assert.ok(/\x1b\[J/.test(text),
      'the resize must take the old block down; zeroing the counters first made this a no-op');
    t.stop();
  });

  test('a write from an unknown column still starts at column 0', () => {
    // erase() returned early when drawnRows was 0, leaving the caret wherever it
    // happened to be. Drawing from there put a second bar beside the first.
    const t = resizable(100);
    t.prompt.drawnRows = 0;
    t.prompt.cursorRow = 0;
    t.take();
    t.prompt.draw();
    assert.ok(t.take().startsWith('\r'),
      'every draw must home the column before writing its first row');
    t.stop();
  });
});

describe('the interface follows the terminal, not a hardcoded ceiling', () => {
  // Reported: stretching the window left the input box and its fill stopping
  // two thirds of the way across while the terminal carried on. Three separate
  // clamps to 120 columns — in theme.js, prompt.js and chatRenderer.js — meant
  // a 220-column terminal wasted 101 columns.
  //
  // The two halves want opposite things and now get them: chrome fills the
  // window; prose does not, because 200 characters per line is genuinely hard
  // to read. That is the same rule the design skills hand to the agent for
  // anyone else's interface.

  test('the input box fills a stretched terminal', () => {
    for (const columns of [100, 160, 220, 400]) {
      const t = drivePrompt(columns);
      assert.equal(t.prompt.width(), columns,
        `at ${columns} columns the prompt sized itself to ${t.prompt.width()}`);

      const rows = writtenRows(t.buffer).filter((row) => row.length);
      const boxRow = rows[0];
      assert.ok(visibleWidth(boxRow) >= columns - 1,
        `the box occupied ${visibleWidth(boxRow)} of ${columns} columns — the rest is dead space`);
    }
  });

  test('prose does NOT fill a stretched terminal', () => {
    const out = { columns: 400, write() { return true; }, isTTY: true, on() {}, removeListener() {} };
    const renderer = new ChatRenderer({ out });
    assert.equal(renderer.width(), 400, 'chrome follows the window');
    assert.ok(renderer.measure() <= 100,
      `prose wrapped at ${renderer.measure()} characters; past roughly 100 the eye loses the return sweep`);
    assert.ok(renderer.measure() < renderer.width(), 'the two must differ on a wide terminal');
  });

  test('on a narrow terminal the two agree', () => {
    const out = { columns: 70, write() { return true; }, isTTY: true, on() {}, removeListener() {} };
    const renderer = new ChatRenderer({ out });
    assert.equal(renderer.measure(), renderer.width(),
      'there is nothing to give back when the terminal is already narrow');
  });

  test('no module reimposes a fixed ceiling', () => {
    for (const file of ['theme.js', 'prompt.js', 'chatRenderer.js']) {
      const source = fs.readFileSync(path.join(here, '..', 'src', 'tui', file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
      assert.ok(!/Math\.min\((?:columns|raw|available)\s*,\s*120\)/.test(source),
        `${file} clamps the width to a fixed 120 again — it cannot follow a window being resized`);
    }
  });

  test('the box reads as a surface: every row the same width, with air', () => {
    const t = drivePrompt(120);
    const rows = writtenRows(t.buffer).filter((row) => row.length);
    // Pad, text, spacer, model row — the footer is not part of the box.
    const box = rows.slice(0, 4);
    const widths = box.map(visibleWidth);
    assert.equal(new Set(widths).size, 1,
      `box rows were ${widths.join(', ')} columns — a ragged fill reads as highlighted text, not a box`);

    // Everything after the left bar must be blank on the air rows. The bar is
    // `▌`, or `|` under `node --test` where there is no TTY and the glyph set
    // falls back to ASCII — so strip a leading bar of either kind first.
    // The bar is `▌`/`|`, and the box's middle row carries a `•`/`*` instead —
    // the dot in "long line, dot in the middle, long line". Strip either.
    const inner = (row) => stripAnsi(row).replace(/^[▌┃|>•*]\s*/, '').trim();

    // Row 0 is opencode's paddingTop={1}: a row of air INSIDE the fill, above
    // the caret. Without it the cursor sat on the very first row of the surface
    // and the box read as a bar rather than something you type into.
    assert.equal(inner(box[0]), '', 'the box opens with a row of air');
    assert.ok(inner(box[1]).length > 0, 'then the line being typed');
    assert.equal(inner(box[2]), '', 'then the spacer that separates it from the model row');
    assert.ok(inner(box[3]).length > 0, 'then the model row');
  });

  test('a cramped terminal gives up its air before it gives up the wordmark', () => {
    // Found by UX-03's sweep, not by eye: the extra bottom row made a 17-row
    // terminal emit exactly 17 rows, which costs the top of the wordmark.
    // opencode's spacers carry minHeight={0} flexShrink={1} for this exact
    // reason; with no flex engine here it is arithmetic instead.
    const boxRows = (rows) => {
      const buffer = [];
      const out = {
        columns: 100, rows, isTTY: true,
        write: (t) => { buffer.push(t); return true; },
        on() {}, removeListener() {}
      };
      const prompt = new ChatPrompt({
        out, input: { isTTY: true, setRawMode() {}, resume() {}, pause() {}, on() {}, off() {} }
      });
      const renderer = new ChatRenderer({ out });
      renderer.status.setSession({ model: 'm', provider: 'p', tier: 't', cwd: '/x', contextLimit: 1000 });
      prompt.attach(renderer);
      prompt.active = true;
      buffer.length = 0;
      prompt.draw();
      return writtenRows(buffer.join('')).length;
    };

    assert.ok(boxRows(17) < boxRows(20), 'a 17-row terminal must draw a shorter block than a 20-row one');
    assert.equal(boxRows(40), boxRows(20), 'and above the threshold the air is the same');
  });

  test('the footer is not welded to the bottom of the box', () => {
    // The other half of the same complaint. opencode puts a one-row bordered
    // spacer between its prompt box and its footer
    // (component/prompt/index.tsx:1487-1497); Causyne had the status row butted
    // straight against the model row, which is what made the whole thing read as
    // jammed into the last four rows of the terminal.
    const t = drivePrompt(120);
    const rows = writtenRows(t.buffer);
    const last = rows.length - 1;
    assert.ok(stripAnsi(rows[last]).trim().length > 0, 'the footer is the last row');
    assert.equal(stripAnsi(rows[last - 1]).trim(), '', 'and there is a row of air above it');
  });
});

describe('the box actually reads as a filled surface', () => {
  // The visual half of "it should look like opencode's box". The rows were the
  // right width all along; the FILL was not continuous.
  //
  // paint() and dim() each close with \x1b[0m, and that resets every attribute
  // including the background the fill had just set. So the surface survived
  // only as far as the first styled word: on a 99-column row the model line was
  // filled for 6 columns and bare for the other 93, and the box read as a stray
  // highlight rather than a surface.
  //
  // Colour is decided at import from the TTY, and `node --test` has none — so
  // these run in a child with FORCE_COLOR set. Skipping instead would mean the
  // check never runs in CI, which is the only place it matters. Same approach
  // tui.test.js already uses for its NO_COLOR assertions.

  function inColour(script) {
    return execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: path.join(here, '..'),
      env: { ...process.env, FORCE_COLOR: '3', NO_COLOR: '', CAUSYNE_NO_COLOR: '0' },
      encoding: 'utf8'
    }).trim();
  }

  test('every row of the input box is filled end to end', () => {
    const report = inColour(`
      import { ChatPrompt } from './src/tui/prompt.js';
      import { ChatRenderer } from './src/tui/chatRenderer.js';
      import { visibleWidth } from './src/tui/text.js';

      /** Columns of a row rendered with a background colour active. */
      function filledColumns(row) {
        let background = false, filled = 0, last = 0, match;
        const pattern = /\\x1b\\[[0-9;]*m/g;
        while ((match = pattern.exec(row))) {
          if (background) filled += visibleWidth(row.slice(last, match.index));
          if (/48;/.test(match[0])) background = true;
          else if (match[0] === '\\x1b[0m') background = false;
          last = match.index + match[0].length;
        }
        if (background) filled += visibleWidth(row.slice(last));
        return filled;
      }

      const problems = [];
      for (const columns of [80, 120, 220]) {
        let buffer = '';
        const out = { columns, write: (t) => { buffer += t; }, isTTY: true, on() {}, removeListener() {} };
        const input = { isTTY: true, setRawMode() {}, resume() {}, pause() {}, on() {}, off() {} };
        const prompt = new ChatPrompt({ out, input, commands: [{ name: 'x' }] });
        const renderer = new ChatRenderer({ out });
        renderer.status.setSession({ model: 'm', provider: 'p', tier: 't', cwd: '/tmp', contextLimit: 1000 });
        prompt.attach(renderer);
        prompt.active = true;
        buffer = '';
        prompt.draw();

        const rows = buffer.replace(/\\x1b\\[J/g, '').replace(/^\\r/, '')
          .split('\\n').map((r) => r.replace(/\\r/g, '')).filter((r) => r.length).slice(0, 3);
        for (const [index, row] of rows.entries()) {
          const width = visibleWidth(row);
          if (filledColumns(row) < width - 1) {
            problems.push(columns + ':row' + index + ' ' + filledColumns(row) + '/' + width);
          }
        }
      }
      console.log(problems.length ? 'PARTIAL ' + problems.join(', ') : 'FULL');
    `);
    assert.equal(report, 'FULL',
      `a partial fill reads as a highlight, not a surface: ${report}`);
  });

  test('fill() re-opens the background after a nested reset', () => {
    const report = inColour(`
      import { fill, paint } from './src/tui/theme.js';
      import { visibleWidth } from './src/tui/text.js';
      const painted = 'plain ' + paint('accent', 'styled') + ' plain';
      const row = fill('surface', painted);
      // The meaningful question is not "is there more than one reset" — paint()
      // brings its own. It is whether a BACKGROUND is re-established after each
      // reset that is not the final one.
      const parts = row.split('\\x1b[0m');
      const reopened = parts.slice(1, -1).every((part) => /\\x1b\\[48;/.test(part));
      const sameWidth = visibleWidth(row) === visibleWidth(painted);
      console.log(JSON.stringify({ reopened, sameWidth, resets: parts.length - 1 }));
    `);
    const { reopened, sameWidth, resets } = JSON.parse(report);
    assert.ok(resets >= 2, 'the fixture must actually contain a nested reset to be meaningful');
    assert.equal(reopened, true,
      'the nested reset must be followed by a fresh background, not left closed');
    assert.equal(sameWidth, true,
      're-opening the background must not change how many columns the row occupies');
  });

  test('fill() is a no-op without colour, so a piped transcript stays clean', () => {
    // Here HAS_COLOR is already false — `node --test` has no TTY — which is
    // exactly the condition being asserted.
    assert.equal(fill('surface', 'text'), 'text');
  });
});


// ---------------------------------------------------------------------------

describe('the same invariant, at stage heights', () => {
  // The clamp was written for a three-row live region. The Stage makes the block
  // twenty times taller and adds a rail that takes columns away from the
  // transcript, so the arithmetic has more places to be wrong and one wrapped
  // row now desynchronises a whole band instead of a footer. Same rule, swept
  // over the geometry that actually ships.
  //
  // Width still comes from a synthetic sink, never a pty — MS-02.

  function driveStage(columns, rows) {
    const written = [];
    const out = {
      columns, rows, isTTY: true,
      write: (text) => { written.push(text); return true; },
      on() {}, removeListener() {}
    };
    const surface = new StageSurface({ out, env: {} });
    surface.open();

    const renderer = new ChatRenderer({ out, transcript: surface.transcript, quietStatus: true });
    renderer.status.setSession({
      model: 'gemini-3.5-flash', provider: 'gemini', tier: 'free',
      cwd: '/Users/someone/projects/a-fairly-long-directory-name',
      contextLimit: 184000, relayEnabled: true
    });

    // Every frame kind the rail knows about, so the composed row includes the
    // widest thing each of them can produce.
    renderer.sessionHeader({ version: 'v1.9.19', provider: 'gemini', model: 'gemini-3.5-flash' });
    for (let i = 0; i < 12; i++) {
      renderer.handle({ type: 'agent_reasoning', content: 'weighing '.repeat(30) });
      renderer.handle({ type: 'step_start', tool: 'fs_write', args: { path: '/very/long/path/'.repeat(6) + 'file.js' } });
      renderer.handle({ type: 'checkpoint', count: 1, tool: 'fs_write', path: '/very/long/path/file.js', step: i });
      renderer.handle({ type: 'step_complete', result: { success: true, output: 'x'.repeat(4000) } });
      renderer.handle({ type: 'agent_message', content: 'ratatouille '.repeat(40) });
      renderer.turnFooter(4200);
    }

    const prompt = new ChatPrompt({
      out, input: { isTTY: true, setRawMode() {}, resume() {}, pause() {}, on() {}, off() {} },
      surface, commands: [{ name: 'skills' }]
    });
    prompt.attachSurface(surface);
    prompt.attach(renderer);
    prompt.active = true;
    prompt.editor.setText('a message long enough to wrap several times '.repeat(4));
    prompt.setBusy(true);
    prompt.draw();
    return { surface, written };
  }

  for (const columns of WIDTHS) {
    for (const rows of [17, 24, 40, 60]) {
      test(`no band row wraps at ${columns}x${rows}`, () => {
        const { surface } = driveStage(columns, rows);
        assert.equal(surface.stage.prev.length, surface.stage.height,
          'the band is exactly its own height');
        for (const row of surface.stage.prev) {
          assert.ok(visibleWidth(row) <= columns - 1,
            `a ${visibleWidth(row)}-column row at ${columns}x${rows} would wrap and desynchronise the band`);
        }
      });
    }
  }

  test('scrolled to the top, the bottom, and the middle, at every width', () => {
    for (const columns of WIDTHS) {
      const { surface } = driveStage(columns, 30);
      for (const at of ['top', 'middle', 'bottom']) {
        if (at === 'top') surface.viewport.toTop();
        else if (at === 'bottom') surface.viewport.toBottom();
        else surface.viewport.scrollTo(Math.floor(surface.viewport.maxScrollTop() / 2));
        surface.present(['status'], { row: 0, col: 0 });
        for (const row of surface.stage.prev) {
          assert.ok(visibleWidth(row) <= columns - 1,
            `${at} at width ${columns}: a ${visibleWidth(row)}-column row`);
        }
      }
    }
  });

  test('a reflow to every width keeps every transcript row inside it', () => {
    // The Stage's own claim: a resize is a re-render, not a re-emit. That is
    // only true if the re-render actually respects the new width.
    const { surface } = driveStage(120, 40);
    for (const columns of WIDTHS) {
      for (const row of surface.transcript.rows(columns)) {
        assert.ok(visibleWidth(row) <= columns,
          `reflowed to ${columns}, a row came back ${visibleWidth(row)} wide`);
      }
    }
  });

  test('every newline the Stage emits is a row it claimed', () => {
    // The precise form of the invariant. A newline inside paint() would scroll
    // the terminal out from under the block; a newline in reserve() or grow() IS
    // how the band is claimed (UX-01 rev 2 clause c). Counting them against the
    // claim is what tells the two apart — the earlier phrasing, "nothing after
    // reserve emits a newline", could not survive a band that grows.
    for (const columns of WIDTHS) {
      const { surface, written } = driveStage(columns, 30);
      const newlines = (written.join('').match(/\n/g) || []).length;
      assert.equal(newlines, surface.stage.stats.claimed,
        `at width ${columns}: ${newlines} newlines for ${surface.stage.stats.claimed} claimed rows`);
    }
  });

  test('and a repaint that claims nothing emits no newline at all', () => {
    for (const columns of WIDTHS) {
      const { surface } = driveStage(columns, 30);
      const before = surface.stage.stats.claimed;
      const written = [];
      const real = surface.stage.out.write;
      surface.stage.out.write = (t) => { written.push(t); return real(t); };
      surface.viewport.toTop();
      surface.present(['status'], { row: 0, col: 0 });
      surface.stage.out.write = real;

      assert.equal(surface.stage.stats.claimed, before, 'a scroll claims nothing');
      assert.ok(!written.join('').includes('\n'), `at width ${columns} paint() emitted a newline`);
    }
  });
});
