// UX-01: chat renders in the NORMAL buffer and never takes the terminal over.
//
// The bug this file exists for: `chat` used to open a full-screen alternate-buffer
// app, writing \x1b[?1049h followed by \x1b[2J. Nothing detects whether a terminal
// honours the alternate buffer — ignoring \x1b[?1049h is silent, so nothing threw
// and nothing fell back. Where it was ignored the clear wiped the user's screen
// into their scrollback and the app painted a full-screen layout into their
// history: a blank block between their shell prompt and the banner.
//
// It was invisible from inside the app. The grid was correct, the wordmark was on
// row 0, the app emitted zero newlines. The damage happened in the terminal, so
// only the BYTE STREAM can prove it is gone.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';

import { ChatPrompt } from '../src/tui/prompt.js';
import { ChatRenderer } from '../src/tui/chatRenderer.js';
import { PromptHistory } from '../src/tui/history.js';
import { wordmark } from '../src/tui/banner.js';
import { stripAnsi, visibleWidth, wrapBlock } from '../src/tui/text.js';
import { handleInput } from '../src/commands.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = (file) => fs.readFileSync(path.join(here, '..', 'src', file), 'utf8');

/** Source with comments stripped — a rule must be judged on code, not prose. */
const code = (file) => source(file)
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');

/** stdin the prompt can take raw mode on and release again. */
function fakeInput() {
  const input = new EventEmitter();
  input.setRawMode = () => {};
  input.resume = () => {};
  input.pause = () => {};
  input.off = input.removeListener.bind(input);
  return input;
}

/** The sequences that mean "I am taking your terminal away from you". */
const FORBIDDEN = [
  ['\x1b[?1049h', 'entered the alternate buffer'],
  ['\x1b[?1049l', 'left the alternate buffer'],
  ['\x1b[2J', 'cleared the screen'],
  ['\x1b[3J', 'cleared the scrollback']
];

describe('UX-01 — chat never clears or takes over the terminal', () => {
  /** Drive a real chat surface and return every byte it wrote. */
  function session({ turns = 3 } = {}) {
    const written = [];
    const out = { write: (t) => { written.push(t); return true; }, columns: 100, rows: 30, isTTY: true };
    const file = path.join(os.tmpdir(), `causyne-ux01-${process.pid}-${Math.random()}`);

    // Exactly what cliMode.chatMode() does: banner straight to stdout, then the
    // renderer appending, then the prompt owning the bottom rows.
    for (const line of wordmark(96)) out.write(line + '\n');

    const renderer = new ChatRenderer({ out });
    const prompt = new ChatPrompt({
      input: fakeInput(), out, history: new PromptHistory({ file })
    });
    prompt.active = true;
    prompt.attach(renderer);
    prompt.draw();

    for (let turn = 0; turn < turns; turn++) {
      prompt.setBusy(true);
      renderer.resetTurn();
      renderer.startSpinner('reading src/tui/prompt.js');
      renderer.onStepStart({ tool: 'fs_read', args: { path: 'src/tui/prompt.js' } });
      renderer.onStepComplete({ ok: true, elapsedMs: 120 });
      renderer.onAgentMessage({ content: `answer for turn ${turn}` });
      renderer.stopSpinner();
      prompt.setBusy(false);
    }
    prompt.stop();

    try { fs.unlinkSync(file); } catch {}
    return written.join('');
  }

  test('a full session emits no screen-clear and no alternate buffer', () => {
    const bytes = session();
    for (const [sequence, what] of FORBIDDEN) {
      assert.ok(!bytes.includes(sequence),
        `chat ${what} — UX-01 forbids it; this is what wiped the user's scrollback`);
    }
  });

  test('the chat entrypoint constructs no full-screen shell', () => {
    const cli = code('cliMode.js');
    assert.ok(!/\bnew AppShell\b/.test(cli), 'chat must not construct the alternate-buffer shell');
    assert.ok(!/\bcanRunShell\s*\(/.test(cli), 'there must be no full-screen gate left to fall through');
  });

  test('the banner is the first thing the user sees, and it is real history', () => {
    const bytes = session({ turns: 0 });
    const plain = stripAnsi(bytes);
    const art = plain.indexOf('█') >= 0 ? plain.indexOf('█') : plain.indexOf('C A U S Y N E');
    assert.ok(art >= 0, 'the wordmark must be written');
    assert.equal(plain.slice(0, art).trim(), '',
      'nothing may be printed above the wordmark — the art is the header');
  });

  test('the conversation is left in the terminal on exit', () => {
    // clearOnShutdown: false, in opencode's words. Leaving must not erase what
    // was said; only the live region comes down.
    const bytes = session({ turns: 2 });
    const plain = stripAnsi(bytes);
    assert.ok(plain.includes('answer for turn 0') && plain.includes('answer for turn 1'),
      'the transcript must survive as terminal history');
  });

  test('the spinner never animates onto the prompt rows', () => {
    // The renderer's own spinner used to write straight to stdout every 90ms with
    // readline.cursorTo, landing inside the prompt block. Attaching a prompt must
    // put the status on the live region instead.
    const written = [];
    const out = { write: (t) => { written.push(t); return true; }, columns: 100, rows: 30, isTTY: true };
    const file = path.join(os.tmpdir(), `causyne-spin-${process.pid}-${Math.random()}`);
    const renderer = new ChatRenderer({ out });
    const prompt = new ChatPrompt({ input: fakeInput(), out, history: new PromptHistory({ file }) });
    prompt.active = true;
    prompt.attach(renderer);

    renderer.startSpinner('working');
    assert.equal(renderer.spinnerTimer, null,
      'an attached prompt owns the status row; the renderer must not run its own spinner');
    prompt.stop();
    try { fs.unlinkSync(file); } catch {}
  });
});

describe('UX-01 — no source can reintroduce a terminal takeover', () => {
  // The recurrence guard. The bug came back once already because the capability
  // lived in a module nobody was looking at; a grep over the shipped source is
  // the only thing that stops the next agent from wiring one up again.

  function sourceFiles() {
    const roots = [path.join(here, '..', 'src')];
    const found = [];
    while (roots.length) {
      const dir = roots.pop();
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) roots.push(full);
        else if (entry.name.endsWith('.js')) found.push(full);
      }
    }
    return found;
  }

  test('nothing in src/ enters the alternate buffer', () => {
    const offenders = [];
    for (const file of sourceFiles()) {
      const text = fs.readFileSync(file, 'utf8');
      // Match the escape as it would be WRITTEN in source, not as a comment.
      const code = text.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
      if (/\\x1b\[\?1049[hl]/.test(code)) offenders.push(path.relative(path.join(here, '..'), file));
    }
    assert.deepEqual(offenders, [],
      'the alternate buffer is banned: it cannot be feature-detected, and where it is ignored the clear that follows destroys the user\'s scrollback');
  });

  test('the only screen clear left is the one the user asks for', () => {
    const clears = [];
    for (const file of sourceFiles()) {
      const text = fs.readFileSync(file, 'utf8');
      const code = text.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
      if (/\\x1b\[[23]J/.test(code)) clears.push(path.relative(path.join(here, '..'), file));
    }
    // ctrl+L in prompt.js is legitimate — the user pressed a key and asked for it.
    assert.deepEqual(clears, ['src/tui/prompt.js'],
      'a screen clear may only happen on an explicit user keystroke (ctrl+L)');
  });
});

describe('UX-02 — mouse reporting cannot be armed without a way back', () => {
  // The recurrence guard the plan asked for, in the same shape as the UX-01 scan
  // above. Behavioural tests prove the current teardown works; this proves the
  // next agent cannot arm reporting from somewhere that has no teardown at all.

  function sourceFiles() {
    const roots = [path.join(here, '..', 'src')];
    const found = [];
    while (roots.length) {
      const dir = roots.pop();
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) roots.push(full);
        else if (entry.name.endsWith('.js')) found.push(full);
      }
    }
    return found;
  }

  const stripComments = (text) =>
    text.split('\n').filter((line) => !line.trim().startsWith('//') && !line.trim().startsWith('*')).join('\n');

  test('the enable bytes exist in exactly one place', () => {
    const owners = [];
    for (const file of sourceFiles()) {
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      if (/\\x1b\[\?100[06]h/.test(code)) owners.push(path.relative(path.join(here, '..'), file));
    }
    assert.deepEqual(owners, ['src/tui/keys.js'],
      'mouse reporting is armed through mouseTracking(); a second spelling is a second teardown to forget');
  });

  test('drag and motion reporting appear nowhere', () => {
    // ?1002 and ?1003 report every drag and every move. A terminal reporting
    // those cannot be dragged over at all, which takes the user's selection away
    // without telling them. Causyne offers no in-app selection, so it has no
    // reason to ask.
    for (const file of sourceFiles()) {
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      assert.ok(!/\\x1b\[\?100[23][hl]/.test(code),
        `${path.relative(path.join(here, '..'), file)} asks for drag or motion reporting`);
    }
  });

  test('whoever arms it also registers the way back', () => {
    const armers = [];
    for (const file of sourceFiles()) {
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      if (/mouseTracking\(\s*true\s*\)/.test(code)) armers.push([file, code]);
    }
    assert.equal(armers.length, 1, 'exactly one module may arm reporting');

    const [file, code] = armers[0];
    const where = path.relative(path.join(here, '..'), file);
    assert.equal(where, 'src/tui/stageSurface.js');
    assert.ok(/mouseTracking\(\s*false\s*\)/.test(code), `${where} arms reporting and never disarms it`);
    assert.ok(/process\.once\(\s*'exit'/.test(code),
      "'exit' covers ordinary exits AND an uncaught exception — measured, not assumed");
  });

  test('opening actually registers a handler for every signal that skips exit', async () => {
    // Deliberately behavioural, not textual. The first draft of this test
    // grepped the source for 'SIGINT' and friends — and passed with the
    // registration loop deleted, because the names still appeared in the exit-code
    // table inside the handler. A scan that cannot fail is worse than no scan:
    // it reports a guarantee nobody is holding.
    const { StageSurface } = await import('../src/tui/stageSurface.js');
    const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const before = SIGNALS.map((sig) => process.listenerCount(sig));

    const out = { columns: 100, rows: 30, isTTY: true, write: () => true, on() {}, removeListener() {} };
    const surface = new StageSurface({ out, env: {} });
    surface.open();
    const during = SIGNALS.map((sig) => process.listenerCount(sig));
    surface.close();
    const after = SIGNALS.map((sig) => process.listenerCount(sig));

    assert.deepEqual(during, before.map((n) => n + 1),
      'a signal with no handler kills the process without emitting exit, leaving the terminal armed');
    assert.deepEqual(after, before, 'and a clean close leaves nothing behind');
  });

  test('no module installs an uncaughtException listener to do it', () => {
    // Any listener at all suppresses Node's default crash behaviour. A terminal
    // restored at the price of swallowing the stack trace is a bad trade;
    // src/daemon.js owns that channel and writes crashes to disk.
    for (const file of sourceFiles()) {
      if (file.endsWith('daemon.js')) continue;
      const code = stripComments(fs.readFileSync(file, 'utf8'));
      assert.ok(!/uncaughtException/.test(code),
        `${path.relative(path.join(here, '..'), file)} takes over the crash channel`);
    }
  });
});

describe('UX-01 rev 2 — a stage session is still permanent history', () => {
  test('the band is claimed by printing, and the transcript survives leaving it', async () => {
    const { StageSurface } = await import('../src/tui/stageSurface.js');
    const written = [];
    const out = {
      columns: 100, rows: 30, isTTY: true,
      write: (t) => { written.push(t); return true; },
      on() {}, removeListener() {}
    };
    const surface = new StageSurface({ out, env: {} });
    surface.open();

    const renderer = new ChatRenderer({ out, transcript: surface.transcript, quietStatus: true });
    renderer.handle({ type: 'agent_message', content: 'answer for turn 0' });
    renderer.handle({ type: 'agent_message', content: 'answer for turn 1' });
    surface.present(['input', 'status'], { row: 0, col: 0 });
    surface.close();

    const bytes = written.join('');
    assert.ok(!bytes.includes('\x1b[?1049h'), 'no alternate buffer');
    assert.ok(!bytes.includes('\x1b[2J') && !bytes.includes('\x1b[3J'), 'no screen clear');
    assert.ok(!/\x1b\[\d*;\d*[Hf]/.test(bytes), 'no absolute cursor addressing');

    const plain = stripAnsi(bytes);
    assert.ok(plain.includes('answer for turn 0') && plain.includes('answer for turn 1'),
      'clause (d): leaving the band must leave the session in the terminal');
  });
});

describe('dialogs live in the region, not in a floating window', () => {
  function host(commands = []) {
    const written = [];
    const out = { write: (t) => { written.push(t); return true; }, columns: 90, rows: 30, isTTY: true, on() {}, removeListener() {} };
    const file = path.join(os.tmpdir(), `causyne-dlg-${process.pid}-${Math.random()}`);
    const prompt = new ChatPrompt({ input: fakeInput(), out, commands, history: new PromptHistory({ file }) });
    prompt.active = true;
    return { prompt, out, text: () => written.join(''), reset: () => { written.length = 0; }, file };
  }

  const COMMANDS = [
    { name: 'help', description: 'show the keys' },
    { name: 'usage', description: 'token spend' },
    { name: 'status', description: 'session facts' }
  ];

  test('ctrl+p opens the command palette', () => {
    const h = host(COMMANDS);
    h.prompt.handleKey({ name: 'p', ctrl: true });
    assert.ok(h.prompt.layer, 'ctrl+p must open a layer');
    const shown = stripAnsi(h.text());
    assert.ok(shown.includes('commands'), 'the palette must be titled');
    assert.ok(shown.includes('help'), 'the palette must list the commands');
    try { fs.unlinkSync(h.file); } catch {}
  });

  test('ctrl+k and ctrl+u stay readline kill bindings', () => {
    // The palette must not cost the user a standard editing key.
    const h = host(COMMANDS);
    h.prompt.editor.insert('keep this cut that');
    for (let i = 0; i < 9; i++) h.prompt.editor.moveLeft();
    h.prompt.handleKey({ name: 'k', ctrl: true });
    assert.equal(h.prompt.layer, null, 'ctrl+k must not open the palette');
    assert.equal(h.prompt.editor.getText(), 'keep this');
    try { fs.unlinkSync(h.file); } catch {}
  });

  test('a layer owns the keyboard while it is up', () => {
    const h = host(COMMANDS);
    h.prompt.handleKey({ name: 'p', ctrl: true });
    h.prompt.handleKey({ name: 'char', text: 'u' });
    assert.equal(h.prompt.editor.getText(), '',
      'typing a filter must not edit the message behind the dialog');
    try { fs.unlinkSync(h.file); } catch {}
  });

  test('escape closes the palette and gives the keyboard back', () => {
    const h = host(COMMANDS);
    h.prompt.handleKey({ name: 'p', ctrl: true });
    h.prompt.handleKey({ name: 'escape' });
    assert.equal(h.prompt.layer, null);
    h.prompt.handleKey({ name: 'char', text: 'x' });
    assert.equal(h.prompt.editor.getText(), 'x');
    try { fs.unlinkSync(h.file); } catch {}
  });

  test('an approval resolves on y, and DISMISSING IT DENIES', async () => {
    const h = host();
    const approved = h.prompt.approve({ tool: 'terminal_exec', risk: 'dangerous', args: { command: 'rm -rf build' } });
    assert.ok(h.prompt.layer, 'the approval must be showing');
    assert.ok(stripAnsi(h.text()).includes('terminal_exec'), 'the tool must be named');
    h.prompt.handleKey({ name: 'y' });
    // approve() now resolves with WHICH option was chosen, because 'Allow
    // always' has to reach the caller — a bare boolean silently downgraded it
    // to a one-off. y is still the shortcut for 'once'.
    assert.deepEqual(await approved, { approved: true, scope: 'once' });

    const denied = h.prompt.approve({ tool: 'fs_delete', risk: 'extreme', args: { path: '/etc' } });
    h.prompt.closeLayer();                       // torn down without an answer
    assert.deepEqual(await denied, { approved: false, scope: 'reject' },
      'dismissing an approval must deny, never approve — and must never grant a standing one');
    try { fs.unlinkSync(h.file); } catch {}
  });

  test('a confirm that is dismissed answers no, and never hangs the turn', async () => {
    const h = host();
    const answer = h.prompt.confirm('Let it continue?');
    h.prompt.closeLayer();
    assert.equal(await answer, false);
    try { fs.unlinkSync(h.file); } catch {}
  });

  test('the panel never exceeds the terminal width', () => {
    for (const columns of [40, 60, 90, 120]) {
      const written = [];
      const out = { write: (t) => { written.push(t); return true; }, columns, rows: 30, isTTY: true, on() {}, removeListener() {} };
      const file = path.join(os.tmpdir(), `causyne-w-${process.pid}-${Math.random()}`);
      const prompt = new ChatPrompt({ input: fakeInput(), out, commands: COMMANDS, history: new PromptHistory({ file }) });
      prompt.active = true;
      prompt.handleKey({ name: 'p', ctrl: true });
      for (const row of stripAnsi(written.join('')).split('\n')) {
        assert.ok(visibleWidth(row) <= columns,
          `a panel row was ${visibleWidth(row)} wide in a ${columns}-column terminal — it would wrap and corrupt the erase`);
      }
      try { fs.unlinkSync(file); } catch {}
    }
  });
});

describe('command output does not collide with the live region', () => {
  // The screenshot bug, in two halves.
  //
  // Half one: `/skills` output printed via console.log landed on top of the
  // status row. That was fixed by routing command output through
  // renderer.write(), which lifts the live region out of the way first.
  //
  // Half two — the half this suite could NOT see: a row WIDER than the terminal
  // wraps onto a second physical row, while ChatPrompt.drawnRows counts logical
  // rows. erase() then walks up one row short and \x1b[J clears from the middle
  // of the block, leaving the rows above it on screen. That is the doubled hint
  // row and the trail of half-drawn glyphs in the report.
  //
  // The emulator below used to DROP characters past `cols` instead of wrapping
  // them, so the corruption was invisible here while being plainly visible on a
  // real terminal. It now implements DEC auto-wrap, which is what makes the
  // failure reproducible in CI.

  // A minimal terminal emulator: enough of CUU/CR/ED/CUF to place rows, plus the
  // deferred wrap a real terminal performs at the right margin.
  function reconstruct(bytes, cols = 80, rows = 24) {
    const grid = Array.from({ length: rows }, () => Array(cols).fill(' '));
    let r = 0, c = 0, i = 0;
    const re = /\x1b\[(\d*)([A-Za-z])/g;
    // A real terminal does not wrap when the cursor REACHES the margin — it wraps
    // when the next glyph is written from there (DEC "deferred wrap"). Modelling
    // that faithfully matters: a row of exactly `cols` columns is fine, and a row
    // of cols + 1 is the one that costs a physical line.
    const put = (ch) => {
      if (c >= cols) { c = 0; r++; }
      if (r < rows && c < cols) grid[r][c] = ch;
      c++;
    };
    while (i < bytes.length) {
      const ch = bytes[i];
      if (ch === '\x1b') {
        re.lastIndex = i; const m = re.exec(bytes);
        if (m && m.index === i) {
          const n = m[1] ? +m[1] : 0, f = m[2];
          if (f === 'A') r = Math.max(0, r - (n || 1));
          else if (f === 'C') c += n || 1;
          else if (f === 'J') { for (let x = c; x < cols; x++) grid[r][x] = ' '; for (let y = r + 1; y < rows; y++) grid[y].fill(' '); }
          i = re.lastIndex; continue;
        }
      }
      if (ch === '\n') { r++; c = 0; i++; continue; }
      if (ch === '\r') { c = 0; i++; continue; }
      put(ch); i++;
    }
    return grid.map((row) => stripAnsi(row.join('')).replace(/\s+$/, ''));
  }

  test('the emulator reproduces a wrap (guards the guard)', () => {
    // Without this the suite silently stops testing anything: an emulator that
    // drops overflow instead of wrapping it reports every layout as correct.
    const screen = reconstruct('x'.repeat(12), 10, 4);
    assert.equal(screen[0], 'xxxxxxxxxx', 'the first row must fill the terminal');
    assert.equal(screen[1], 'xx', 'the overflow must land on the NEXT row, not vanish');
  });

  test('submitting /skills leaves the output clean, echoed once, status intact', async () => {
    const COLS = 102; // the width in the reported screenshot
    const written = [];
    const out = { write: (t) => { written.push(t); return true; }, columns: COLS, rows: 24, isTTY: true, on() {}, removeListener() {} };
    const file = path.join(os.tmpdir(), `causyne-skills-${process.pid}-${Math.random()}`);
    const prompt = new ChatPrompt({ input: fakeInput(), out, history: new PromptHistory({ file }) });
    const renderer = new ChatRenderer({ out });
    prompt.start();
    prompt.attach(renderer);
    prompt.draw();

    prompt.editor.insert('/skills');
    prompt.draw();
    prompt.submit();

    // The REAL command output, not a short stand-in. Its longest row reached 195
    // columns on this 102-column terminal, which is the input that broke.
    const result = await handleInput('/skills', { surface: 'terminal' });
    assert.ok(result && result.output, '/skills must produce output');
    renderer.write('\n' + wrapBlock(result.output, renderer.width()).join('\n') + '\n');
    await new Promise((r) => setImmediate(r));

    const screen = reconstruct(written.join(''), COLS, 40);
    const nonEmpty = screen.filter((l) => l.length);

    // /skills echoed exactly once. The echo is a left-barred block now, so the
    // marker is the block glyph rather than the old bare arrow.
    const echoRows = nonEmpty.filter((l) => /^\s*[|>▸▏]\s*\/skills\s*$/.test(l));
    assert.equal(echoRows.length, 1, `/skills was echoed ${echoRows.length} times, expected 1`);

    // Every LOGICAL row written must fit the terminal.
    //
    // This is the assertion that actually pins the bug. A terminal wraps an
    // over-wide row silently, so by the time it reaches the grid the evidence is
    // an innocent-looking pair of rows. Measured before the terminal sees them,
    // an over-wide row is unambiguous — and the unwrapped `/skills` output
    // produced rows of 195 columns on this 102-column terminal.
    for (const logical of stripAnsi(written.join('')).split('\n')) {
      const row = logical.replace(/\r/g, '');
      assert.ok(visibleWidth(row) <= COLS,
        `a written row occupied ${visibleWidth(row)} of ${COLS} columns: ${JSON.stringify(row.slice(0, 70))}`);
    }

    // The command output row must not share a line with the prompt or status.
    const outputRow = nonEmpty.findIndex((l) => l.includes('Compiled skills'));
    assert.ok(outputRow >= 0, 'the command output must be printed');
    assert.ok(!/ctrl\+p commands/.test(nonEmpty[outputRow]), 'output collided with the status row');

    // The idle hint appears exactly once. Two copies is the reported corruption.
    const hintRows = nonEmpty.filter((l) => /\/ commands\s+·\s+@ files/.test(l));
    assert.ok(hintRows.length <= 1,
      `the input hint was drawn ${hintRows.length} times — the live region was not erased cleanly`);

    prompt.stop();
    try { fs.unlinkSync(file); } catch {}
  });
});


describe('nothing writes to the terminal behind the live region', () => {
  // The other half of the reported corruption.
  //
  // The prompt keeps a repainted block at the bottom of the terminal and lifts
  // it out of the way through renderer.write()'s onBeforeWrite/onAfterWrite
  // hooks. console.log bypasses those entirely: the line lands ON TOP of the
  // drawn block, and drawnRows then describes a block that is no longer where
  // it thinks it is. agentLoop.js carried eighteen such calls and checkpoints.js
  // three — a tier banner, a task shape, cache hits, compaction notices — every
  // one of them firing mid-turn, exactly when the live region is drawn.
  //
  // User-facing lines now go out as `notice` frames through the same path as
  // every other frame; diagnostics are gated behind CAUSYNE_DEBUG on stderr.

  // src/cortex/* joined the list after its provisioning notices were seen
  // smearing the spinner across a first-run download.
  const GUARDED_SOURCES = [
    'src/agentLoop.js', 'src/checkpoints.js',
    'src/cortex/provisioner.js', 'src/cortex/vectorDb.js', 'src/cortex/autoCondenser.js'
  ];

  for (const relative of GUARDED_SOURCES) {
    test(`${relative} makes no ungated write to stdout`, () => {
      const source = fs.readFileSync(path.join(here, '..', relative), 'utf8');
      const offenders = [];
      source.split('\n').forEach((line, index) => {
        // Skip comments — these files describe the bug at length.
        const code = line.replace(/^\s*(\/\/|\*|\/\*).*$/, '');
        if (/\bconsole\s*\.\s*(log|info|warn|error|debug)\s*\(/.test(code)) {
          offenders.push(`${relative}:${index + 1}  ${line.trim().slice(0, 70)}`);
        }
      });
      assert.deepEqual(offenders, [],
        `console output during a turn overwrites the prompt's live region; use this.notice() or debugLog():\n${offenders.join('\n')}`);
    });
  }

  test('the renderer understands the notice frame', () => {
    const written = [];
    const out = { write: (t) => { written.push(t); return true; }, columns: 80, isTTY: true, on() {}, removeListener() {} };
    const renderer = new ChatRenderer({ out });

    let lifted = 0;
    let restored = 0;
    renderer.onBeforeWrite = () => { lifted++; };
    renderer.onAfterWrite = () => { restored++; };

    assert.equal(renderer.handle({ type: 'notice', message: 'tier free' }), true,
      'an unhandled notice frame would silently vanish');
    assert.ok(lifted > 0 && restored > 0,
      'a notice must pass through write(), so the live region is lifted and restored');
    assert.ok(stripAnsi(written.join('')).includes('tier free'));
  });

  test('a notice is wrapped to the terminal rather than overflowing it', () => {
    const written = [];
    const out = { write: (t) => { written.push(t); return true; }, columns: 60, isTTY: true, on() {}, removeListener() {} };
    const renderer = new ChatRenderer({ out });
    renderer.handle({ type: 'notice', message: 'compacted '.repeat(30) });
    for (const row of stripAnsi(written.join('')).split('\n')) {
      assert.ok(visibleWidth(row) <= 60,
        `a notice row of ${visibleWidth(row)} columns exceeds the terminal`);
    }
  });

  test('a notice cannot carry an escape sequence from untrusted text', () => {
    const written = [];
    const out = { write: (t) => { written.push(t); return true; }, columns: 80, isTTY: true, on() {}, removeListener() {} };
    new ChatRenderer({ out }).handle({ type: 'notice', message: 'ok\x1b[2Jwiped' });
    assert.ok(!written.join('').includes('\x1b[2J'),
      'notice text must go through safeDisplay — UX-01 forbids a clear from anywhere');
  });
});
