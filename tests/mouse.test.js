// The wheel scrolls the box — and the terminal is handed back however we die.
//
// Two independent risks live here, and the second is the one that hurts a user
// who never asked for any of this:
//
//  1. DECODING. Mouse reports arrive as escape sequences on the same stdin the
//     editor reads. A report that is not consumed becomes literal text in the
//     user's line; a report that is mis-consumed leaves its tail behind to be
//     read as keystrokes nobody typed. Both are worse than having no wheel.
//  2. TEARDOWN (UX-02). Mouse reporting is process-outliving state. Left armed
//     after a crash, the user's terminal starts emitting escape codes into
//     whatever they type next and their selection stops working, with no way to
//     know what did it. 'exit' covers ordinary exits and uncaught exceptions;
//     signals do not emit it and need handlers of their own.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { KeyDecoder, mouseTracking } from '../src/tui/keys.js';
import { StageSurface } from '../src/tui/stageSurface.js';
import { ChatPrompt } from '../src/tui/prompt.js';
import { PromptHistory } from '../src/tui/history.js';

const here = path.dirname(fileURLToPath(import.meta.url));

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
  return { isTTY: true, setRawMode() {}, resume() {}, pause() {}, on() {}, off() {} };
}

const decode = (...chunks) => {
  const decoder = new KeyDecoder();
  const events = [];
  for (const chunk of chunks) events.push(...decoder.decode(chunk));
  return events;
};

// ---------------------------------------------------------------------------

describe('what we ask the terminal for', () => {
  test('press/release and SGR encoding, and nothing else', () => {
    const on = mouseTracking(true);
    assert.ok(on.includes('\x1b[?1000h'), 'button reporting is what carries the wheel');
    assert.ok(on.includes('\x1b[?1006h'), 'SGR encoding, so coordinates survive past column 223');

    // The whole of UX-02's first half. ?1002 and ?1003 report drag and motion,
    // and a terminal reporting those cannot be dragged over at all.
    assert.ok(!on.includes('?1002'), 'no drag reporting');
    assert.ok(!on.includes('?1003'), 'no motion reporting');
  });

  test('the disable string undoes exactly what the enable string did', () => {
    const off = mouseTracking(false);
    assert.ok(off.includes('\x1b[?1000l') && off.includes('\x1b[?1006l'));
  });
});

// ---------------------------------------------------------------------------

describe('decoding a mouse report', () => {
  test('wheel up and down, with 0-based coordinates', () => {
    const [up] = decode('\x1b[<64;10;5M');
    assert.equal(up.name, 'wheel');
    assert.deepEqual(up.wheel, { direction: 'up', x: 9, y: 4 });

    const [down] = decode('\x1b[<65;10;5M');
    assert.deepEqual(down.wheel, { direction: 'down', x: 9, y: 4 });
  });

  test('modifiers live in the button code, not in a CSI parameter', () => {
    // 64 (wheel up) + 4 (shift) + 16 (ctrl)
    const [key] = decode('\x1b[<84;1;1M');
    assert.equal(key.name, 'wheel');
    assert.equal(key.shift, true);
    assert.equal(key.ctrl, true);
    assert.equal(key.alt, false);
  });

  test('a click is consumed and named, not dropped and not turned into text', () => {
    const [press] = decode('\x1b[<0;3;4M');
    assert.equal(press.name, 'mouse');
    assert.deepEqual(press.mouse, { button: 0, pressed: true, x: 2, y: 3 });
    const [release] = decode('\x1b[<0;3;4m');
    assert.equal(release.mouse.pressed, false);
  });

  test('a report split across chunks is held, not half-decoded', () => {
    // stdin does not respect sequence boundaries. Without the partial buffer,
    // the tail of a split report is read as characters the user never typed.
    for (const cut of [3, 5, 7, 9, 11]) {
      const whole = '\x1b[<65;12;34M';
      const events = decode(whole.slice(0, cut), whole.slice(cut));
      assert.equal(events.length, 1, `split at ${cut} produced ${events.length} events`);
      assert.equal(events[0].name, 'wheel');
      assert.deepEqual(events[0].wheel, { direction: 'down', x: 11, y: 33 });
    }
  });

  test('several reports in one chunk all come out', () => {
    const events = decode('\x1b[<64;1;1M\x1b[<64;1;1M\x1b[<65;1;1M');
    assert.deepEqual(events.map((e) => e.wheel.direction), ['up', 'up', 'down']);
  });

  test('a report next to real typing does not eat the typing', () => {
    const events = decode('a\x1b[<64;1;1Mb');
    assert.deepEqual(events.map((e) => e.name), ['char', 'wheel', 'char']);
    assert.equal(events[0].text + events[2].text, 'ab');
  });

  test('X10 encoding is decoded rather than left as loose bytes', () => {
    // We always ask for ?1006, but a terminal that does not understand it
    // ignores it silently and answers in X10 anyway — and "silently ignores" is
    // the exact failure UX-01 exists because of. The three payload bytes are
    // offset by 32 and routinely above 127, so they are not valid UTF-8: read as
    // text they would corrupt the line.
    const bytes = Buffer.from([0x1b, 0x5b, 0x4d, 32 + 64, 32 + 10, 32 + 5]);
    const events = decode(bytes);
    assert.equal(events.length, 1);
    assert.equal(events[0].name, 'wheel');
    assert.deepEqual(events[0].wheel, { direction: 'up', x: 9, y: 4 });
  });

  test('a truncated X10 report waits for the rest', () => {
    const decoder = new KeyDecoder();
    assert.deepEqual(decoder.decode(Buffer.from([0x1b, 0x5b, 0x4d, 32 + 64])), []);
    const events = decoder.decode(Buffer.from([32 + 10, 32 + 5]));
    assert.equal(events.length, 1);
    assert.equal(events[0].wheel.direction, 'up');
  });

  test('a malformed report is consumed as unknown, never as text', () => {
    const events = decode('\x1b[<;;M');
    assert.equal(events.length, 1);
    assert.equal(events[0].name, 'unknown');
  });

  test('bracketed paste still wins over everything', () => {
    const events = decode('\x1b[200~pasted \x1b[<64;1;1M text\x1b[201~');
    assert.equal(events.length, 1);
    assert.equal(events[0].name, 'paste');
    assert.ok(events[0].text.includes('64;1;1M'), 'inside a paste it is literal content');
  });
});

// ---------------------------------------------------------------------------

describe('the wheel moves the viewport', () => {
  function host({ rows = 30, columns = 90, env = {} } = {}) {
    const out = sink({ rows, columns });
    const surface = new StageSurface({ out, env });
    surface.open();
    const file = path.join(os.tmpdir(), `causyne-mouse-${process.pid}-${Math.random()}`);
    const prompt = new ChatPrompt({
      input: fakeInput(), out, surface, history: new PromptHistory({ file })
    });
    prompt.attachSurface(surface);
    prompt.active = true;
    for (let i = 0; i < 200; i++) {
      surface.transcript.append({ kind: 'notice', produce: () => [`row ${i}`] });
    }
    prompt.draw();
    return { prompt, surface, out };
  }

  test('three rows per notch, up and back down', () => {
    const { prompt, surface } = host();
    assert.equal(surface.viewport.following, true);
    const from = surface.viewport.scrollTop;

    prompt.handleKey({ name: 'wheel', wheel: { direction: 'up', x: 0, y: 0 } });
    assert.equal(from - surface.viewport.scrollTop, 3);
    assert.equal(surface.viewport.following, false);

    prompt.handleKey({ name: 'wheel', wheel: { direction: 'down', x: 0, y: 0 } });
    assert.equal(surface.viewport.scrollTop, from);
    assert.equal(surface.viewport.following, true, 'back at the bottom is back to following');
  });

  test('a click is swallowed and does not reach the editor', () => {
    const { prompt } = host();
    prompt.editor.setText('untouched');
    prompt.handleKey({ name: 'mouse', mouse: { button: 0, pressed: true, x: 5, y: 5 } });
    assert.equal(prompt.editor.getText(), 'untouched');
  });

  test('a stray wheel report with no stage is still swallowed', () => {
    // The case that matters: a failed teardown leaves the terminal reporting,
    // the user runs Causyne again on a stream that gets no stage, and every
    // scroll would otherwise type escape codes into their message.
    const file = path.join(os.tmpdir(), `causyne-mouse-${process.pid}-${Math.random()}`);
    const prompt = new ChatPrompt({
      input: fakeInput(), out: sink(), history: new PromptHistory({ file })
    });
    prompt.active = true;
    prompt.editor.setText('untouched');
    prompt.handleKey({ name: 'wheel', wheel: { direction: 'up', x: 0, y: 0 } });
    prompt.handleKey({ name: 'mouse', mouse: { button: 0, pressed: true, x: 1, y: 1 } });
    assert.equal(prompt.editor.getText(), 'untouched');
  });
});

// ---------------------------------------------------------------------------

describe('UX-02 — the terminal is handed back', () => {
  test('opening arms reporting, closing disarms it', () => {
    const out = sink({ rows: 30 });
    const surface = new StageSurface({ out, env: {} });
    surface.open();
    assert.ok(out.text().includes('\x1b[?1000h'));
    assert.equal(surface.mouseOn, true);

    out.reset();
    surface.close();
    assert.ok(out.text().includes('\x1b[?1000l'), 'and it is the FIRST thing close does');
    assert.equal(surface.mouseOn, false);
  });

  test('CAUSYNE_MOUSE=0 never arms it in the first place', () => {
    const out = sink({ rows: 30 });
    const surface = new StageSurface({ out, env: { CAUSYNE_MOUSE: '0' } });
    surface.open();
    assert.ok(!out.text().includes('?1000h'));
    assert.equal(surface.mouseOn, false);
    surface.close();
  });

  test('suspend hands the terminal to a shell-out, resume takes it back', () => {
    const out = sink({ rows: 30 });
    const surface = new StageSurface({ out, env: {} });
    surface.open();
    out.reset();

    surface.suspend();
    assert.ok(out.text().includes('\x1b[?1000l'), 'a child on inherited stdio gets a clean terminal');
    assert.equal(surface.stage.reserved, false);

    out.reset();
    surface.resume();
    assert.ok(out.text().includes('\x1b[?1000h'));
    assert.equal(surface.stage.reserved, true);
  });

  test('handlers are registered for the signals that do not emit exit', () => {
    const before = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((s) => process.listenerCount(s));
    const surface = new StageSurface({ out: sink({ rows: 30 }), env: {} });
    surface.open();
    const during = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((s) => process.listenerCount(s));
    surface.close();
    const after = ['SIGINT', 'SIGTERM', 'SIGHUP'].map((s) => process.listenerCount(s));

    assert.deepEqual(during, before.map((n) => n + 1), 'every signal that kills us silently');
    assert.deepEqual(after, before, 'and nothing is left behind after a clean close');
  });

  test('no uncaughtException listener is added — that channel is not ours', () => {
    // Any listener at all suppresses Node's default crash behaviour. A terminal
    // restored at the price of swallowing the stack trace is a bad trade;
    // src/daemon.js owns that channel and writes crashes to disk.
    const before = process.listenerCount('uncaughtException');
    const surface = new StageSurface({ out: sink({ rows: 30 }), env: {} });
    surface.open();
    assert.equal(process.listenerCount('uncaughtException'), before);
    surface.close();
  });

  test('a real crash still restores the terminal', () => {
    // Driven in a child process, because the assertion is about what a dying
    // process writes on its way out. 'exit' is emitted after an uncaught
    // exception (measured: code 1, stack printed) and that is what carries this.
    const script = `
      import { StageSurface } from ${JSON.stringify(path.join(here, '..', 'src/tui/stageSurface.js'))};
      const surface = new StageSurface({
        out: Object.assign(Object.create(process.stdout), {
          isTTY: true, columns: 90, rows: 30,
          write: (t) => process.stdout.write(t)
        }),
        env: {}
      });
      surface.stage.out = { columns: 90, rows: 30, isTTY: true, write: (t) => process.stdout.write(t) };
      surface.open();
      setTimeout(() => { throw new Error('simulated crash'); }, 1);
    `;
    const file = path.join(os.tmpdir(), `causyne-crash-${process.pid}.mjs`);
    fs.writeFileSync(file, script);
    let output = '';
    try {
      execFileSync(process.execPath, [file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (error) {
      output = String(error.stdout || '');
    }
    fs.rmSync(file, { force: true });
    assert.ok(output.includes('\x1b[?1000l'),
      'the disable bytes must be on the wire even when the process is dying');
  });
});
