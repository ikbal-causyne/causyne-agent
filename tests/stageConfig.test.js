// Phase 6: the switches, the way out, and a binding that never fired.
//
// Three things are being pinned here.
//
// 1. CONFIG. `CAUSYNE_STAGE`, `CAUSYNE_MOUSE` and `CAUSYNE_RAIL` already existed;
//    the wheel had no tuning at all. Env wins over the config file, because
//    every other Stage switch is an env var and someone debugging a terminal
//    wants one place to turn things off.
//
// 2. `/print`. The Stage keeps the transcript in memory and paints a window of
//    it, so until you exit there is nothing in your terminal's own scrollback to
//    grep, copy or pipe. This is the way out without ending the session.
//
// 3. A BINDING THAT NEVER FIRED. `ctrl+alt+u` / `ctrl+alt+d` were bound in phase
//    2 and worked only under the kitty keyboard protocol. An ordinary terminal
//    sends `ESC` + the control byte, which decoded to a key literally NAMED
//    `\x15` — a name no binding can match. It shipped firing on almost nobody,
//    and nothing failed, which is exactly why it took until now to notice.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { KeyDecoder } from '../src/tui/keys.js';
import { Viewport, ScrollAcceleration, DEFAULT_SCROLL_SPEED } from '../src/tui/viewport.js';
import { StageSurface, scrollSettings } from '../src/tui/stageSurface.js';
import { Transcript } from '../src/tui/transcript.js';
import { ChatPrompt } from '../src/tui/prompt.js';
import { PromptHistory } from '../src/tui/history.js';
import { runCommand } from '../src/commands.js';
import { stripAnsi } from '../src/tui/text.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function sink({ columns = 100, rows = 40, isTTY = true } = {}) {
  const chunks = [];
  return {
    columns, rows, isTTY,
    write(t) { chunks.push(t); return true; },
    on() {}, removeListener() {},
    text: () => chunks.join(''), reset: () => { chunks.length = 0; }, chunks
  };
}

function fakeInput() {
  return { isTTY: true, setRawMode() {}, resume() {}, pause() {}, on() {}, off() {} };
}

function host({ columns = 100, rows = 30, env = {} } = {}) {
  const out = sink({ columns, rows });
  const surface = new StageSurface({ out, env });
  surface.open();
  const file = path.join(os.tmpdir(), `causyne-cfg-${process.pid}-${Math.random()}`);
  const prompt = new ChatPrompt({
    input: fakeInput(), out, surface, history: new PromptHistory({ file })
  });
  prompt.attachSurface(surface);
  prompt.active = true;
  return { prompt, surface, out };
}

// ---------------------------------------------------------------------------

describe('wheel tuning', () => {
  test('the default is three rows and no acceleration', () => {
    assert.deepEqual(scrollSettings({}, null), { speed: DEFAULT_SCROLL_SPEED, accelerate: false });
  });

  test('the config file is read when the environment is silent', () => {
    assert.deepEqual(
      scrollSettings({}, { tui: { scrollSpeed: 5, scrollAcceleration: true } }),
      { speed: 5, accelerate: true }
    );
  });

  test('the environment wins, including when it turns something off', () => {
    assert.deepEqual(
      scrollSettings({ CAUSYNE_SCROLL_SPEED: '2', CAUSYNE_SCROLL_ACCEL: '0' },
        { tui: { scrollSpeed: 5, scrollAcceleration: true } }),
      { speed: 2, accelerate: false }
    );
  });

  test('an absurd speed is clamped rather than obeyed', () => {
    // A wheel that moves half the screen per notch is not a preference.
    assert.equal(scrollSettings({ CAUSYNE_SCROLL_SPEED: '900' }, null).speed, 20);
    assert.equal(scrollSettings({ CAUSYNE_SCROLL_SPEED: '-4' }, null).speed, DEFAULT_SCROLL_SPEED);
    assert.equal(scrollSettings({ CAUSYNE_SCROLL_SPEED: 'nonsense' }, null).speed, DEFAULT_SCROLL_SPEED);
  });

  test('the surface builds a viewport from the settings', () => {
    const out = sink();
    const fast = new StageSurface({ out, env: { CAUSYNE_SCROLL_SPEED: '7' } });
    assert.equal(fast.viewport.speed, 7);
    assert.equal(fast.viewport.acceleration, null, 'acceleration stays opt-in');

    const accelerated = new StageSurface({ out, env: { CAUSYNE_SCROLL_ACCEL: '1' } });
    assert.ok(accelerated.viewport.acceleration instanceof ScrollAcceleration);
  });
});

describe('acceleration, when it is asked for', () => {
  test('a streak builds up and a pause resets it', () => {
    const accel = new ScrollAcceleration();
    let now = 1000;
    assert.equal(accel.tick(now), 1, 'the first notch is never accelerated');
    now += 20;
    const streak = accel.tick(now);
    assert.ok(streak > 1 && streak <= 6, `expected a multiplier in (1, 6], got ${streak}`);

    // A gap longer than the streak timeout means a new gesture.
    assert.equal(accel.tick(now + 500), 1);
  });

  test('a terminal that double-reports a notch does not inflate the curve', () => {
    // Some terminals emit the same wheel notch twice within a millisecond or
    // two. The duplicate must not count as a second, faster notch — otherwise
    // the same physical gesture accelerates twice as hard on those terminals.
    const run = (duplicate) => {
      const accel = new ScrollAcceleration();
      const real = [];
      const dupes = [];
      let now = 1000;
      accel.tick(now);
      for (let i = 0; i < 5; i++) {
        now += 30;
        real.push(accel.tick(now));
        if (duplicate) dupes.push(accel.tick(now + 1));
      }
      return { real, dupes };
    };

    const withDupes = run(true);
    assert.deepEqual(withDupes.real, run(false).real,
      'the real notches must accelerate identically whether or not the terminal echoed them');
    assert.deepEqual(withDupes.dupes, [1, 1, 1, 1, 1],
      'and the echo itself must contribute no scroll at all');
  });

  test('it is capped', () => {
    const accel = new ScrollAcceleration();
    let now = 1000;
    accel.tick(now);
    for (let i = 0; i < 40; i++) now += 7;
    assert.ok(accel.tick(now) <= 6);
  });

  test('a viewport with acceleration moves further on a fast streak', () => {
    const transcript = new Transcript();
    for (let i = 0; i < 500; i++) transcript.append({ kind: 'notice', produce: () => [`r${i}`] });

    const plain = new Viewport({ transcript, height: 10, width: 80 });
    const quick = new Viewport({ transcript, height: 10, width: 80, acceleration: new ScrollAcceleration() });
    plain.refresh(500);
    quick.refresh(500);

    let now = 5000;
    for (let i = 0; i < 6; i++) { plain.wheel('up', 1, now); quick.wheel('up', 1, now); now += 20; }
    assert.ok(quick.scrollTop < plain.scrollTop,
      `accelerated ${quick.scrollTop} should be further up than flat ${plain.scrollTop}`);
  });
});

// ---------------------------------------------------------------------------

describe('/print — the way out without ending the session', () => {
  test('it flushes the transcript into real scrollback and starts clean', async () => {
    const { prompt, surface, out } = host();
    for (let i = 0; i < 12; i++) {
      surface.transcript.append({ kind: 'notice', produce: () => [`line ${i}`] });
    }
    prompt.draw();
    out.reset();

    const result = await runCommand('print', [], { surface: 'terminal', prompt });
    assert.equal(result.ok, true);
    assert.match(result.output, /Printed 12 rows/);

    const written = stripAnsi(out.text());
    assert.match(written, /line 0/, 'it printed BEFORE clearing — ctrl+L leaves your history behind and so must this');
    assert.match(written, /line 11/);
    assert.equal(surface.transcript.length, 0, 'and the band starts clean');
    assert.equal(surface.stage.reserved, true, 'with the band still claimed');
  });

  test('without a stage it says so instead of pretending', async () => {
    const result = await runCommand('print', [], { surface: 'terminal' });
    assert.equal(result.ok, true);
    assert.match(result.output, /already prints straight into your terminal/);
  });

  test('it is a terminal command', async () => {
    const result = await runCommand('print', [], { surface: 'terminal' });
    assert.equal(result.ok, true);
  });
});

// ---------------------------------------------------------------------------

describe('alt+ctrl chords now reach their bindings', () => {
  test('an ordinary terminal decodes ESC + control byte as ctrl+alt+letter', () => {
    const decoder = new KeyDecoder();
    const [key] = decoder.decode(Buffer.from([0x1b, 0x15]));
    assert.equal(key.name, 'u');
    assert.equal(key.ctrl, true);
    assert.equal(key.alt, true);
  });

  test('and the half-page scroll it was bound to actually happens', () => {
    // The end-to-end version, because the decode being right and the binding
    // being right are two different things and only one of them was.
    const { prompt, surface } = host();
    for (let i = 0; i < 300; i++) {
      surface.transcript.append({ kind: 'notice', produce: () => [`r${i}`] });
    }
    prompt.draw();
    const from = surface.viewport.scrollTop;

    for (const key of new KeyDecoder().decode(Buffer.from([0x1b, 0x15]))) prompt.handleKey(key);
    assert.equal(from - surface.viewport.scrollTop, Math.floor(surface.viewport.height / 2));
  });

  test('the keys it must not have stolen still work', () => {
    // ESC+control-byte is a NEW branch in the escape decoder, so the pairs that
    // were already special-cased have to keep winning over it.
    const decode = (bytes) => new KeyDecoder().decode(Buffer.from(bytes))[0];
    assert.equal(decode([0x1b, 0x0d]).name, 'enter');
    assert.equal(decode([0x1b, 0x0d]).alt, true);
    assert.equal(decode([0x1b, 0x7f]).name, 'backspace');
    assert.equal(decode([0x1b, 0x1b]).name, 'escape');
    assert.equal(decode([0x1b, 0x5b, 0x41]).name, 'up', 'ESC [ is still the CSI introducer');
    assert.equal(decode([0x1b, 0x4f, 0x50]).name, 'f1', 'ESC O is still SS3');
  });

  test('a bare ctrl chord is unchanged', () => {
    const [key] = new KeyDecoder().decode(Buffer.from([0x15]));
    assert.equal(key.name, 'u');
    assert.equal(key.ctrl, true);
    assert.equal(key.alt, false);
  });
});

// ---------------------------------------------------------------------------

describe('alt+u offers the undo without ever performing it', () => {
  test('it prefills the command and names the restore point', () => {
    const { prompt, surface } = host();
    for (let i = 0; i < 20; i++) {
      surface.transcript.append({ kind: 'step', produce: () => [`s${i}`] });
    }
    surface.transcript.append({
      kind: 'checkpoint',
      meta: { path: '/tmp/app.js', step: 7, taskId: 't1' },
      produce: () => ['     · restore point']
    });
    prompt.draw();

    prompt.handleKey({ name: 'u', alt: true });
    assert.equal(prompt.editor.getText(), '/undo',
      'offered, not run — and /undo is preview-by-default, so even this path is a read');
    assert.match(prompt.notice, /step 7/);
    assert.match(prompt.notice, /app\.js/);
  });

  test('a draft the user is part-way through is never overwritten', () => {
    const { prompt, surface } = host();
    surface.transcript.append({
      kind: 'checkpoint', meta: { path: '/tmp/a.js', step: 1 }, produce: () => ['cp']
    });
    prompt.editor.setText('half a thought');
    prompt.handleKey({ name: 'u', alt: true });

    assert.equal(prompt.editor.getText(), 'half a thought');
    assert.match(prompt.notice, /run \/undo to preview/);
  });

  test('with no restore points it says so rather than doing something', () => {
    const { prompt, surface } = host();
    surface.transcript.append({ kind: 'notice', produce: () => ['nothing to roll back'] });
    prompt.handleKey({ name: 'u', alt: true });
    assert.equal(prompt.editor.getText(), '');
    assert.match(prompt.notice, /no restore points/);
  });

  test('it does nothing at all without a stage', () => {
    const file = path.join(os.tmpdir(), `causyne-cfg-${process.pid}-${Math.random()}`);
    const prompt = new ChatPrompt({
      input: fakeInput(), out: sink(), history: new PromptHistory({ file })
    });
    prompt.active = true;
    prompt.handleKey({ name: 'u', alt: true });
    assert.equal(prompt.editor.getText(), '');
  });
});

// ---------------------------------------------------------------------------

describe('the launcher hands the terminal back before it prints a crash', () => {
  const launcher = fs.readFileSync(path.join(here, '..', 'bin', 'causyne.js'), 'utf8');

  test('a crash inside the bundle disarms the terminal first', () => {
    // This branch catches a throw from INSIDE the running bundle, which can
    // happen long after the Stage armed mouse reporting and hid the cursor.
    const code = launcher.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert.ok(code.indexOf('process.stdout.write') < code.indexOf("console.error('Causyne Agent failed:'"));
    assert.match(code, /\\x1b\[\?1000l/, 'the mouse must be disarmed');
    assert.match(code, /\\x1b\[\?25h/, 'and the cursor put back');
  });

  test('and it loads the readable source included in the package', () => {
    // The packaging trap: package.json "files" does not ship src/, so a relative
    // import here resolves on a dev checkout and throws ERR_MODULE_NOT_FOUND on
    // every npm install, before a line of this file runs.
    assert.match(launcher, /import\('\.\.\/src\/entrypoint\.js'\)/);
  });
});
