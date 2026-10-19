// Scroll the box, not the terminal.
//
// The viewport behavior is stated as assertions: the wheel and the
// keyboard move a viewport over a retained transcript; while a task runs the view
// follows the bottom; scrolling up freezes it and lets content grow underneath;
// coming back resumes following.
//
// The subtle half is the follow flag, and it is subtle enough to be worth saying
// twice: it is DERIVED from position on every scroll mutation, never assigned
// from an event (@opentui/core ScrollBox.ts:224-242). The obvious version — set
// a flag when the user presses a key — is wrong in both directions, because a
// programmatic scroll then looks like user intent and returning to the bottom by
// wheel does not clear it. Several tests below exist only to pin that down.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import { Viewport, DEFAULT_SCROLL_SPEED } from '../src/tui/viewport.js';
import { Transcript } from '../src/tui/transcript.js';
import { StageSurface } from '../src/tui/stageSurface.js';
import { ChatPrompt } from '../src/tui/prompt.js';
import { ChatRenderer } from '../src/tui/chatRenderer.js';
import { PromptHistory } from '../src/tui/history.js';
import { visibleWidth, stripAnsi } from '../src/tui/text.js';

function sink({ columns = 100, rows = 40, isTTY = true } = {}) {
  const chunks = [];
  return {
    columns, rows, isTTY,
    write(text) { chunks.push(text); return true; },
    on() {}, removeListener() {},
    text: () => chunks.join(''),
    reset: () => { chunks.length = 0; },
    chunks
  };
}

function fakeInput() {
  return {
    isTTY: true,
    setRawMode() {}, resume() {}, pause() {},
    on() {}, off() {}
  };
}

/** A transcript of `n` single-row frames. */
function filled(n, transcript = new Transcript()) {
  for (let i = 0; i < n; i++) {
    transcript.append({ kind: 'notice', produce: () => [`row ${i}`] });
  }
  return transcript;
}

// ---------------------------------------------------------------------------

describe('following the bottom while a task runs', () => {
  test('content arriving keeps the view pinned', () => {
    const transcript = new Transcript();
    const viewport = new Viewport({ transcript, height: 10, width: 80 });

    for (let i = 0; i < 50; i++) {
      transcript.append({ kind: 'notice', produce: () => [`row ${i}`] });
      viewport.refresh(1);
    }

    assert.equal(viewport.following, true);
    assert.equal(viewport.scrollTop, viewport.maxScrollTop());
    assert.deepEqual(viewport.rows().at(-1), 'row 49', 'the newest row is on screen');
  });

  test('a programmatic follow does not read as the user scrolling', () => {
    // The reentrancy guard. Without it the auto-scroll's own write would be
    // seen by sync() as a scroll and could set the very flag it is gated on.
    const transcript = filled(60);
    const viewport = new Viewport({ transcript, height: 10, width: 80 });
    viewport.refresh(60);
    assert.equal(viewport.manual, false);
    assert.equal(viewport.following, true);
  });

  test('scrolling up freezes the view and content grows underneath', () => {
    const transcript = filled(50);
    const viewport = new Viewport({ transcript, height: 10, width: 80 });
    viewport.refresh(50);

    viewport.wheel('up');
    const held = viewport.scrollTop;
    assert.ok(held < viewport.maxScrollTop());
    assert.equal(viewport.following, false, 'derived from position, not from the event');

    for (let i = 0; i < 20; i++) {
      transcript.append({ kind: 'notice', produce: () => [`late ${i}`] });
      viewport.refresh(1);
    }

    assert.equal(viewport.scrollTop, held, 'the view did not move under the reader');
    assert.equal(viewport.unseen, 20, 'and it counted what arrived while they were away');
  });

  test('scrolling down to within a row of the end resumes following', () => {
    // The case the tolerance exists for: a wheel of three rows per notch does
    // not divide evenly into the distance remaining, so you land one row short
    // and follow would never resume. Applied to DOWNWARD motion only — see the
    // note in scrollTo() for why the reference's placement cannot work here.
    const transcript = filled(50);
    const viewport = new Viewport({ transcript, height: 10, width: 80 });
    viewport.refresh(50);

    viewport.wheel('up');
    assert.equal(viewport.following, false);

    viewport.lineDown(viewport.maxScrollTop() - viewport.scrollTop - 1);
    assert.equal(viewport.scrollTop, viewport.maxScrollTop(), 'one row short means the end');
    assert.equal(viewport.following, true);
  });

  test('but scrolling UP by one row is left exactly where it was put', () => {
    const transcript = filled(50);
    const viewport = new Viewport({ transcript, height: 10, width: 80 });
    viewport.refresh(50);

    viewport.lineUp();
    assert.equal(viewport.scrollTop, viewport.maxScrollTop() - 1);
    assert.equal(viewport.following, false, 'the snap must not swallow a deliberate scroll');
  });

  test('a one-row scroll is not undone by the next repaint', () => {
    // Causyne departs from the reference here on purpose. opencode applies the
    // re-engage tolerance on ANY size change, and refresh() runs on every frame
    // because the viewport is re-measured whenever the input box changes height
    // — so scrolling up one row would be snapped back by the next keystroke and
    // the key would visibly do nothing.
    const transcript = filled(50);
    const viewport = new Viewport({ transcript, height: 10, width: 80 });
    viewport.refresh(50);

    viewport.lineUp();
    const held = viewport.scrollTop;
    assert.equal(held, viewport.maxScrollTop() - 1);

    viewport.refresh(0);
    viewport.refresh(0);
    assert.equal(viewport.scrollTop, held, 'no growth, so no re-engage');
    assert.equal(viewport.following, false);
  });

  test('toBottom resumes following unconditionally', () => {
    const transcript = filled(50);
    const viewport = new Viewport({ transcript, height: 10, width: 80 });
    viewport.refresh(50);
    viewport.pageUp();
    assert.equal(viewport.following, false);

    viewport.toBottom();
    assert.equal(viewport.following, true);
    assert.equal(viewport.scrollTop, viewport.maxScrollTop());
    assert.equal(viewport.unseen, 0);
  });

  test('a shrinking transcript never strands the view past the end', () => {
    const transcript = filled(50);
    const viewport = new Viewport({ transcript, height: 10, width: 80 });
    viewport.refresh(50);
    viewport.scrollTo(30);

    transcript.clear();
    viewport.refresh(0);
    assert.equal(viewport.scrollTop, 0);
  });

  test('a resize does not silently unfollow', () => {
    // Growing the viewport lowers maxScrollTop. Leaving scrollTop above it
    // would read as "the user scrolled away" and stop the auto-scroll for the
    // rest of the session.
    const transcript = filled(50);
    const viewport = new Viewport({ transcript, height: 10, width: 80 });
    viewport.refresh(50);
    assert.equal(viewport.following, true);

    viewport.resize({ height: 30 });
    assert.equal(viewport.following, true);
    assert.equal(viewport.scrollTop, viewport.maxScrollTop());

    viewport.resize({ height: 5 });
    assert.equal(viewport.following, true);
  });

  test('nothing to scroll means nothing to unfollow', () => {
    const transcript = filled(3);
    const viewport = new Viewport({ transcript, height: 20, width: 80 });
    viewport.refresh(3);
    viewport.wheel('up');
    assert.equal(viewport.following, true, 'a viewport larger than its content is always at the bottom');
  });
});

// ---------------------------------------------------------------------------

describe('the wheel', () => {
  test('one notch moves three rows by default', () => {
    const transcript = filled(200);
    const viewport = new Viewport({ transcript, height: 10, width: 80 });
    viewport.refresh(200);
    const from = viewport.scrollTop;
    viewport.wheel('up');
    assert.equal(from - viewport.scrollTop, DEFAULT_SCROLL_SPEED);
  });

  test('a fractional speed does not drift', () => {
    // This is what the accumulator is for: at speed 1.5, two notches must move
    // three rows, not two or four.
    const transcript = filled(200);
    const viewport = new Viewport({ transcript, height: 10, width: 80, speed: 1.5 });
    viewport.refresh(200);
    const from = viewport.scrollTop;
    viewport.wheel('up');
    viewport.wheel('up');
    assert.equal(from - viewport.scrollTop, 3);
  });

  test('scrolling past either end saturates instead of throwing', () => {
    const transcript = filled(200);
    const viewport = new Viewport({ transcript, height: 10, width: 80 });
    viewport.refresh(200);
    for (let i = 0; i < 500; i++) viewport.wheel('up');
    assert.equal(viewport.scrollTop, 0);
    for (let i = 0; i < 500; i++) viewport.wheel('down');
    assert.equal(viewport.scrollTop, viewport.maxScrollTop());
    assert.equal(viewport.following, true, 'arriving at the bottom clears the flag');
  });
});

// ---------------------------------------------------------------------------

describe('keyboard motion', () => {
  const setup = () => {
    const transcript = filled(200);
    const viewport = new Viewport({ transcript, height: 20, width: 80 });
    viewport.refresh(200);
    return viewport;
  };

  test('a page keeps one row of overlap', () => {
    const viewport = setup();
    const from = viewport.scrollTop;
    viewport.pageUp();
    assert.equal(from - viewport.scrollTop, 19, 'a full viewport minus the carry-over row');
  });

  test('a half page is half a viewport, unlike the reference', () => {
    const viewport = setup();
    const from = viewport.scrollTop;
    viewport.halfPageUp();
    assert.equal(from - viewport.scrollTop, 10);
  });

  test('top and bottom', () => {
    const viewport = setup();
    viewport.toTop();
    assert.equal(viewport.scrollTop, 0);
    assert.equal(viewport.following, false);
    viewport.toBottom();
    assert.equal(viewport.scrollTop, viewport.maxScrollTop());
  });

  test('jump moves between frame boundaries, not by rows', () => {
    const transcript = new Transcript();
    for (let i = 0; i < 10; i++) {
      transcript.append({ kind: 'step', produce: () => [`step ${i}`, '  detail', ''] });
    }
    const viewport = new Viewport({ transcript, height: 5, width: 80 });
    viewport.refresh(30);
    viewport.toTop();

    viewport.jump(1);
    assert.equal(viewport.scrollTop, 3, 'the second frame starts at row 3');
    viewport.jump(1);
    assert.equal(viewport.scrollTop, 6);
    viewport.jump(-1);
    assert.equal(viewport.scrollTop, 3);
  });

  test('jump can filter by kind, which is what turn-to-turn navigation needs', () => {
    const transcript = new Transcript();
    transcript.append({ kind: 'turn', produce: () => ['turn A'] });
    for (let i = 0; i < 5; i++) transcript.append({ kind: 'step', produce: () => [`s${i}`] });
    transcript.append({ kind: 'turn', produce: () => ['turn B'] });
    // Enough tail that row 6 is reachable — scrollTo clamps to maxScrollTop, so
    // a jump target past the end would otherwise be tested against the clamp
    // rather than against the jump.
    for (let i = 0; i < 10; i++) transcript.append({ kind: 'step', produce: () => [`t${i}`] });

    const viewport = new Viewport({ transcript, height: 3, width: 80 });
    viewport.refresh(17);
    viewport.toTop();
    viewport.jump(1, ['turn']);
    assert.equal(viewport.scrollTop, 6, 'skipped the five steps between the turns');
  });
});

// ---------------------------------------------------------------------------

describe('the surface composes the band', () => {
  function surfaceOn(out) {
    const surface = new StageSurface({ out, env: {} });
    surface.open();
    return surface;
  }

  test('viewport on top, prompt underneath, exactly the band height', () => {
    const out = sink({ rows: 30, columns: 90 });
    const surface = surfaceOn(out);
    filled(100, surface.transcript);
    out.reset();

    const promptRows = ['box top', 'box body', 'status'];
    surface.present(promptRows, { row: 1, col: 5 });

    assert.equal(surface.stage.prev.length, 29, 'the band is exactly its own height');
    assert.deepEqual(surface.stage.prev.slice(-3), promptRows, 'the prompt owns the bottom rows');
    assert.equal(surface.viewport.height, 26, 'and the viewport gets what is left');
    assert.equal(surface.stage.caret.row, 26 + 1, 'the caret is offset by the viewport');
    assert.equal(surface.stage.caret.col, 5);
  });

  test('the viewport shrinks as the input box grows', () => {
    const out = sink({ rows: 30 });
    const surface = surfaceOn(out);
    filled(100, surface.transcript);

    surface.present(['one'], { row: 0, col: 0 });
    assert.equal(surface.viewport.height, 28);
    surface.present(Array(9).fill('row'), { row: 0, col: 0 });
    assert.equal(surface.viewport.height, 20);
  });

  test('a prompt that would eat the band is trimmed from the top', () => {
    const out = sink({ rows: 20 });
    const surface = surfaceOn(out);
    filled(100, surface.transcript);

    const huge = Array.from({ length: 40 }, (_, i) => `p${i}`);
    surface.present(huge, { row: 39, col: 0 });

    const band = surface.stage.prev;
    assert.equal(band.length, 19);
    assert.equal(band.at(-1), 'p39', 'the status footer and the caret row are what survive');
    assert.ok(surface.viewport.height >= 2, 'the transcript never vanishes entirely');
  });

  test('being scrolled away is visible', () => {
    const out = sink({ rows: 30 });
    const surface = surfaceOn(out);
    filled(200, surface.transcript);
    surface.present(['status'], { row: 0, col: 0 });
    assert.equal(surface.viewport.following, true);

    surface.viewport.pageUp();
    for (let i = 0; i < 5; i++) {
      surface.transcript.append({ kind: 'notice', produce: () => ['late'] });
    }
    surface.present(['status'], { row: 0, col: 0 });

    const lastViewportRow = stripAnsi(surface.stage.prev.at(-2));
    assert.match(lastViewportRow, /5 new below/,
      'un-following must be legible, or the user cannot tell it from a stalled agent');
  });

  test('a repaint with nothing new still costs nothing', () => {
    const out = sink({ rows: 30 });
    const surface = surfaceOn(out);
    filled(100, surface.transcript);
    surface.present(['status'], { row: 0, col: 0 });
    out.reset();
    assert.equal(surface.present(['status'], { row: 0, col: 0 }), 0);
    assert.equal(out.text(), '');
  });
});

// ---------------------------------------------------------------------------

describe('the exit contract', () => {
  test('close collapses the band and flushes the session to scrollback', () => {
    const out = sink({ rows: 30 });
    const surface = new StageSurface({ out, env: {} });
    surface.open();
    filled(12, surface.transcript);
    surface.present(['status'], { row: 0, col: 0 });
    out.reset();

    assert.equal(surface.close(), true);
    const text = out.text();
    assert.ok(text.includes('\x1b[J'), 'the band is given back');
    for (let i = 0; i < 12; i++) {
      assert.ok(text.includes(`row ${i}`), `row ${i} reached real scrollback`);
    }
    assert.ok(!text.includes('\x1b[2J') && !text.includes('\x1b[?1049h'));
  });

  test('evicted frames are printed too — eviction is not deletion', () => {
    const out = sink({ rows: 30 });
    const surface = new StageSurface({ out, env: {} });
    surface.transcript.maxFrames = 5;
    surface.open();
    filled(20, surface.transcript);
    out.reset();

    surface.close();
    const text = out.text();
    assert.ok(text.includes('row 0'), 'a frame that fell out of the model still reaches the exit log');
    assert.ok(text.includes('row 19'));
  });

  test('ctrl+L prints through and starts clean, rather than destroying the record', () => {
    const out = sink({ rows: 30 });
    const surface = new StageSurface({ out, env: {} });
    surface.open();
    filled(12, surface.transcript);
    out.reset();

    surface.flushAndClear();
    const text = out.text();
    assert.ok(text.includes('row 0') && text.includes('row 11'),
      'in a terminal ctrl+L leaves your history behind; so does this');
    assert.equal(surface.transcript.length, 0);
    assert.equal(surface.stage.reserved, true, 'and the band is back');
  });
});

// ---------------------------------------------------------------------------

describe('ChatPrompt on the Stage', () => {
  function host({ rows = 30, columns = 90 } = {}) {
    const out = sink({ rows, columns });
    const surface = new StageSurface({ out, env: {} });
    surface.open();

    const renderer = new ChatRenderer({ out, transcript: surface.transcript, quietStatus: true });
    const file = path.join(os.tmpdir(), `causyne-vp-${process.pid}-${Math.random()}`);
    const prompt = new ChatPrompt({
      input: fakeInput(), out, surface,
      history: new PromptHistory({ file })
    });
    prompt.attachSurface(surface);
    prompt.attach(renderer);
    prompt.active = true;
    return { prompt, surface, renderer, out, file };
  }

  test('drawing paints the band and never scrolls the terminal', () => {
    const { prompt, surface, out } = host();
    out.reset();
    prompt.draw();

    const text = out.text();
    assert.ok(text.length > 0, 'something was painted');
    // Newlines are allowed only as claimed rows: an empty session starts with a
    // one-row band and grows to fit the prompt. What must never happen is a
    // newline that claims nothing, which would scroll the band away.
    assert.equal((text.match(/\n/g) || []).length, surface.stage.stats.claimed - 1,
      'every newline in this draw is a row the band claimed');
    assert.ok(!text.includes('\x1b[2J') && !text.includes('\x1b[?1049h'));
    assert.equal(prompt.drawnRows, 0, 'nothing of the prompt is on the terminal for erase() to walk');
  });

  test('a submitted message becomes a frame, not a write', () => {
    const { prompt, surface, out } = host();
    prompt.editor.setText('hello from the stage');
    out.reset();
    prompt.submit();

    assert.ok(!out.text().includes('hello from the stage'),
      'it must not reach stdout — the band is at the bottom of the screen');
    const kinds = surface.transcript.markers(90).map((m) => m.kind);
    assert.ok(kinds.includes('user'));
    assert.match(stripAnsi(surface.transcript.rows(90).join('\n')), /hello from the stage/);
  });

  test('the agent answering scrolls the box, not the terminal', () => {
    const { prompt, renderer, surface, out } = host();
    prompt.draw();
    const claimedBefore = surface.stage.stats.claimed;
    out.reset();

    for (let i = 0; i < 40; i++) {
      renderer.handle({ type: 'agent_message', content: `answer ${i}` });
    }
    prompt.draw();

    const claimedByGrowth = surface.stage.stats.claimed - claimedBefore;
    assert.equal((out.text().match(/\n/g) || []).length, claimedByGrowth,
      'the terminal scrolled only by the rows the band claimed as it grew');
    assert.ok(claimedByGrowth > 0, 'and it did grow — forty answers do not fit a four-row band');
    assert.equal(surface.viewport.following, true);
    const band = surface.stage.prev.map(stripAnsi).join('\n');
    assert.match(band, /answer 39/, 'the newest answer is on screen');
    assert.ok(!band.includes('answer 0'), 'and the oldest has scrolled out of the box');
  });

  test('pageup scrolls the viewport; ctrl+u still kills the line', () => {
    const { prompt, surface } = host();
    for (let i = 0; i < 200; i++) {
      surface.transcript.append({ kind: 'notice', produce: () => [`row ${i}`] });
    }
    prompt.draw();
    assert.equal(surface.viewport.following, true);

    prompt.handleKey({ name: 'pageup' });
    assert.equal(surface.viewport.following, false, 'pageup is a scroll key on the Stage');

    prompt.handleKey({ name: 'pagedown', shift: true });
    assert.equal(surface.viewport.following, true, 'shift+pgdn is the way back to following');

    // The trap this avoids: a chat where the key that deletes your line also
    // scrolls. tests/chatSurface.test.js asserts these stay editing keys.
    prompt.editor.setText('keep me');
    prompt.handleKey({ name: 'u', ctrl: true });
    assert.equal(prompt.editor.getText(), '', 'ctrl+u is still kill-to-start');
  });

  test('every row painted into the band fits the terminal', () => {
    for (const columns of [40, 60, 80, 102, 120, 200]) {
      const { prompt, renderer, surface } = host({ columns, rows: 24 });
      renderer.handle({ type: 'agent_message', content: 'ratatouille '.repeat(60) });
      prompt.editor.setText('a message that is quite long '.repeat(4));
      prompt.draw();

      for (const row of surface.stage.prev) {
        assert.ok(visibleWidth(row) <= columns - 1,
          `a ${visibleWidth(row)}-column row at width ${columns} would wrap and desynchronise the band`);
      }
    }
  });

  test('stopping the prompt leaves the session in the terminal', () => {
    const { prompt, renderer, out } = host();
    renderer.handle({ type: 'agent_message', content: 'the answer was 42' });
    prompt.draw();
    out.reset();

    prompt.stop();
    assert.match(stripAnsi(out.text()), /the answer was 42/,
      'leaving Causyne still leaves a transcript behind');
  });

  test('a terminal that becomes too short hands the session back to scrollback', () => {
    const { prompt, surface, out } = host({ rows: 30 });
    assert.ok(prompt.surface);

    out.rows = 8;
    assert.equal(surface.resize(), false);
    assert.equal(surface.stage.reserved, false, 'the band was given back');
  });
});
