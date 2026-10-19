import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildWindow, sanitizeSequences } from '../src/contextManager.js';
import { resolveUserPath } from '../src/utils/paths.js';
import { PACK_PLAYBOOKS } from '../src/toolPacks.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Every test here reproduces something that actually happened on the owner's
// machine during a 340,000-token Blender run. None of them were hypothetical.

// ---------------------------------------------------------------------------
// The task killer: a request with no user or tool message
// ---------------------------------------------------------------------------

test('window: a single message larger than the pool still yields a window', () => {
  // THE BUG: buildWindow broke on the first message that did not fit, so one
  // oversized message produced an EMPTY window. The agent loop then skipped its
  // root anchor (guarded on `slidingWindow.length > 0`) and sent the provider
  // system blocks only — a 400 that killed the run at step 13.
  const messages = [
    { role: 'user', content: 'build the pen' },
    { role: 'assistant', content: 'x'.repeat(5000) }
  ];
  const { window } = buildWindow(messages, 1000);

  assert.ok(window.length > 0, 'an oversized message produced an empty window again');
  assert.match(window[window.length - 1].content, /truncated/, 'the kept message was not truncated to fit');
});

test('window: dropping leading orphan tool results never empties the window', () => {
  const messages = [
    { role: 'tool', tool_call_id: '1', content: 'r'.repeat(100) },
    { role: 'tool', tool_call_id: '2', content: 'r'.repeat(100) }
  ];
  const { window } = buildWindow(messages, 100000);
  assert.ok(window.length > 0, 'a window of only tool results was emptied');
});

test('assembly: a request always carries a user or tool message', async () => {
  // The invariant, asserted against the real assembly code rather than a mock:
  // two independent paths can strip every user/tool turn, and relying on either
  // to stay correct is what cost the run.
  const loop = fs.readFileSync(path.join(HERE, '..', 'src', 'agentLoop.js'), 'utf8');

  assert.match(
    loop,
    /if \(!prunedMessages\.some\(m => m\.role === 'user' \|\| m\.role === 'tool'\)\)/,
    'the last-moment re-anchor is gone; a stripped window can 400 the provider again'
  );
  assert.ok(
    !/slidingWindow\.length > 0 && slidingWindow\[0\] !== this\.messages\[0\]/.test(loop),
    'the root anchor is guarded on a non-empty window again — that guard WAS the bug'
  );
});

test('assembly: system-only messages are detectable as invalid', () => {
  // Documents the exact provider contract that was violated.
  const systemOnly = sanitizeSequences([{ role: 'system', content: 'prompt' }]);
  assert.equal(systemOnly.some((m) => m.role === 'user' || m.role === 'tool'), false);
});

// ---------------------------------------------------------------------------
// The tilde: the agent could not look at its own render
// ---------------------------------------------------------------------------

test('paths: a leading ~ is expanded, not treated as a directory', () => {
  // `path.resolve('~/x')` returns `<cwd>/~/x`. view_image failed in 17ms on a
  // file that existed, at the one step that separates a good render from a bad
  // one: looking at your own work.
  assert.equal(resolveUserPath('~'), os.homedir());
  assert.equal(resolveUserPath('~/a/b.png'), path.join(os.homedir(), 'a', 'b.png'));
  assert.ok(!resolveUserPath('~/a.png').includes('~'), 'the tilde survived into the resolved path');

  // Absolute and relative paths keep working.
  assert.equal(resolveUserPath('/tmp/x.png'), '/tmp/x.png');
  assert.equal(resolveUserPath('a.png'), path.resolve('a.png'));
  // A tilde inside a name is a filename, not a home reference.
  assert.ok(resolveUserPath('./backup~.png').endsWith('backup~.png'));
});

test('paths: the tools that take a model-supplied path use the resolver', () => {
  for (const file of ['viewImage.js', 'archive.js']) {
    const source = fs.readFileSync(path.join(HERE, '..', 'src', 'tools', file), 'utf8');
    assert.match(source, /resolveUserPath\(args\./, `${file} resolves a model path without expanding ~`);
  }
});

// ---------------------------------------------------------------------------
// Blender: a stub shadowed the real install, and the agent shelled out
// ---------------------------------------------------------------------------

test('blender: a candidate must identify itself as Blender, not merely exist', async () => {
  // THE BUG: `~/.causyne/engines/blender/blender` is checked first so a user can
  // supply their own build. On a real machine it held a 55-byte shell script
  // that echoed one line and exited 0, shadowing a genuine Blender 5.2 LTS in
  // /Applications. Every headless render invoked the stub, reported success and
  // produced nothing — a silent total failure.
  const source = fs.readFileSync(path.join(HERE, '..', 'src', 'tools', 'blenderAutomator.js'), 'utf8');

  assert.match(source, /execFileSync\(cand, \['--version'\]/, 'candidates are no longer probed');
  assert.match(source, /\^blender\\s\+\\d/i, 'the identity check is gone; any executable file would pass again');
});

test('blender: local CLI preflight resolves and validates the binary', () => {
  const source = fs.readFileSync(path.join(HERE, '..', 'src', 'tools', 'blenderAutomator.js'), 'utf8');
  assert.match(source, /const blenderBin = getBlenderExecutablePath\(\)/,
    'execution no longer resolves Blender using the cross-platform candidates');
  assert.doesNotMatch(source, /connectViewport|checkBridge|127\.0\.0\.1:9333/,
    'the held editor socket surface returned to the active tool');
});

test('blender: the playbook forbids `which blender`', () => {
  const media = PACK_PLAYBOOKS.media;
  // Asserts the INTENT, not the heading. This previously pinned the literal
  // string "Never shell out to find Blender" and so failed the moment the rule
  // was widened past Blender to every bundled binary — a test defending the
  // narrower version of the bug it was written to prevent.
  assert.match(media, /Never infer installation from PATH alone/, 'the guidance is gone');
  assert.match(media, /Do NOT run `which blender`/, 'the specific prohibition is gone');
  assert.ok(
    !/`which blender` failing is not the end of the task/.test(media),
    'the playbook still tells the agent to run the command that lies'
  );
});

test('blender: the playbook forbids starting a large download unprompted', () => {
  assert.match(
    PACK_PLAYBOOKS.media,
    /Never start a large\ndownload on your own initiative/,
    'nothing stops the agent re-downloading software the user already has'
  );
});

// ---------------------------------------------------------------------------
// The UI bugs: output from one command bled into another, and the user's own
// message came back as fragments of its own tail
// ---------------------------------------------------------------------------

test('render: a tab never reaches the terminal, because a tab does not erase', async () => {
  // WHAT WAS SEEN: `sw_vers` rendered as
  //   ProductName:P_FIX_PLAN.mdmacOS
  //   ProductVersion:EGOTIATION26.5.2
  // where P_FIX_PLAN.md and EGOTIATION are tails of FILENAMES printed by the
  // previous command. A tab moves the cursor without writing, so in a region
  // that redraws in place it jumps over stale cells and leaves them visible.
  const { safeDisplay, visibleWidth } = await import('../src/tui/text.js');

  const rendered = safeDisplay('ProductName:\t\tmacOS');
  assert.ok(!rendered.includes('\t'), 'a raw tab reached the render path');
  assert.equal(rendered.indexOf('macOS'), 24, 'tab stops must be preserved, not collapsed');

  // And the measurement, which is the half that corrupts row counts.
  assert.equal(visibleWidth(rendered), 29, 'width must match what the terminal actually advances');
});

test('render: tab stops reset on every line', async () => {
  const { sanitize } = await import('../src/tui/text.js');
  const rows = sanitize('a:\tX\nlonger:\tY').split('\n');
  assert.equal(rows[0].indexOf('X'), 8);
  assert.equal(rows[1].indexOf('Y'), 8);
});

test('render: a committed block never fills the final column', async () => {
  // WHAT WAS SEEN: a six-line user message came back as six stray fragments of
  // its own tail. Every row was built to EXACTLY the terminal width, so the
  // terminal wrapped each one — six drawn rows occupied twelve real ones, and
  // erase() walked back six.
  const { ChatPrompt } = await import('../src/tui/prompt.js');
  const { visibleWidth, stripAnsi } = await import('../src/tui/text.js');

  for (const width of [80, 100, 128, 155]) {
    const written = [];
    const prompt = Object.create(ChatPrompt.prototype);
    prompt.surface = null;
    prompt.erase = () => {};
    prompt.width = () => width;
    prompt.out = { write: (text) => written.push(text) };

    prompt.commit('user', (w) => [
      'x'.repeat(w),          // a row that fills the terminal exactly
      'y'.repeat(w + 40)      // and one that overruns it outright
    ]);

    for (const row of written.join('').split('\n').filter(Boolean)) {
      assert.ok(
        visibleWidth(stripAnsi(row)) <= width - 1,
        `a committed row was ${visibleWidth(stripAnsi(row))} wide in a ${width}-column terminal`
      );
    }
  }
});

test('render: the user message block reserves the last column at every width', async () => {
  const { wrapBlock, visibleWidth, stripAnsi } = await import('../src/tui/text.js');
  const { barBlock, GUTTER } = await import('../src/tui/block.js');

  const message = 'Buat pena 3D di Blender dan render jadi klip sinematik 8 detik.\n'
    + 'Pena: barrel logam brushed, grip karet, clip krom. Tiga material berbeda.';

  for (const width of [60, 80, 128, 200]) {
    const blockWidth = Math.max(8, width - 1);
    const rows = barBlock(
      wrapBlock(message, Math.max(8, blockWidth - 1 - GUTTER)),
      { width: blockWidth, role: 'user', filled: true, surface: 'surfaceHi' }
    );
    const widest = Math.max(...rows.map((r) => visibleWidth(stripAnsi(r))));
    assert.ok(widest <= width - 1, `widest row ${widest} in a ${width}-column terminal`);
  }
});

test('render: barBlock still honours the width it is given', async () => {
  // The column is reserved by the CALLER, not by the component. A block asked
  // for 40 columns must produce 40 — it has no idea it is terminal-width.
  const { barBlock } = await import('../src/tui/block.js');
  const { visibleWidth } = await import('../src/tui/text.js');

  for (const row of barBlock(['short', 'a longer line here'], { width: 40 })) {
    assert.equal(visibleWidth(row), 40, 'a filled block reads as a surface only if rows match');
  }
});

// ---------------------------------------------------------------------------
// TUI: a command drawn as a message, and a wheel that went nowhere
// ---------------------------------------------------------------------------

test('tui: a slash command is drawn as an invocation, not as a message', async () => {
  // WHAT WAS SEEN: typing `/usage` rendered exactly like a sentence sent to the
  // model. The command DID run and its output appeared underneath, but the
  // transcript showed a conversation turn that never happened — submit() echoed
  // every line as a user block BEFORE the caller decided what the line was.
  const { ChatPrompt } = await import('../src/tui/prompt.js');
  const { isCommandInput } = await import('../src/commands.js');
  const { stripAnsi } = await import('../src/tui/text.js');

  const run = (line) => {
    const committed = [];
    const prompt = Object.create(ChatPrompt.prototype);
    prompt.editor = { getText: () => line, clear() {}, isEmpty: false };
    prompt.history = { add() {} };
    prompt.busy = false;
    prompt.waiter = null;
    prompt.completion = null;
    prompt.erase = () => {};
    prompt.isCommand = isCommandInput;
    prompt.commit = (kind, produce) => committed.push({ kind, rows: produce(60).map(stripAnsi) });
    prompt.submit();
    return committed;
  };

  const command = run('/usage');
  assert.equal(command[0].kind, 'command', '/usage was committed as something other than a command');
  assert.ok(!command.some((c) => c.kind === 'user'), '/usage was also drawn as a user message');

  const message = run('buat pena 3d di blender');
  assert.equal(message[0].kind, 'user', 'a real message stopped being drawn as one');
});

test('tui: a path that merely starts with a slash is still a message', async () => {
  const { isCommandInput } = await import('../src/commands.js');
  assert.equal(isCommandInput('/usage'), true);
  assert.equal(isCommandInput('/usr/local/bin'), false, 'a path was treated as a command');
  assert.equal(isCommandInput('usage'), false);
});

test('tui: the wheel reports whether it actually moved', async () => {
  // WHAT WAS SEEN: "cannot keep scrolling back to the start of the
  // conversation". Two things scroll — this band's viewport and the terminal's
  // own scrollback above it — and with mouse reporting on, the app received
  // EVERY wheel event and swallowed it unconditionally. At the top of the band
  // further scrolling therefore did nothing at all, and the earlier
  // conversation was unreachable.
  const { Viewport } = await import('../src/tui/viewport.js');
  const viewport = new Viewport({ transcript: { height: () => 100 }, height: 10, width: 80 });

  viewport.scrollTo(50);
  viewport.wheel('up');
  assert.equal(viewport.lastWheelMoved, true, 'a wheel in the middle of the content did not move');

  viewport.scrollTo(0);
  viewport.wheel('up');
  assert.equal(viewport.lastWheelMoved, false, 'the top boundary is not detectable, so the wheel cannot be released');

  viewport.scrollTo(0);
  viewport.wheel('down');
  assert.equal(viewport.lastWheelMoved, true);
});

test('tui: the surface can hand the wheel back to the terminal and take it again', async () => {
  const { StageSurface } = await import('../src/tui/stageSurface.js');

  for (const method of ['releaseMouse', 'captureMouse']) {
    assert.equal(typeof StageSurface.prototype[method], 'function', `${method} is gone`);
  }

  const written = [];
  const surface = Object.create(StageSurface.prototype);
  surface.out = { write: (text) => written.push(text) };
  surface.mouseCaptured = true;
  // Taking the wheel back forces a full repaint, so the stub needs a stage.
  surface.stage = { invalidate: () => {} };

  assert.equal(surface.releaseMouse(), true, 'the wheel could not be released');
  assert.equal(surface.releaseMouse(), false, 'releasing twice should be a no-op');
  assert.equal(surface.captureMouse(), true, 'the wheel could not be taken back');
  assert.ok(written.length >= 2, 'nothing was written to the terminal to change mouse reporting');
});

test('tui: the band stops painting while the terminal owns the scroll', async () => {
  // WHAT WAS SEEN: scrolling the terminal left a stray rail column down the
  // middle of the screen and fragments of old frames at the edges. The Stage
  // repaints by DIFF against the rows it believes are on screen; when the
  // terminal's own scrollback moves, those rows are somewhere else and every
  // write lands in the wrong place.
  const { StageSurface } = await import('../src/tui/stageSurface.js');
  const source = await import('node:fs').then((fs) =>
    fs.readFileSync(new URL('../src/tui/stageSurface.js', import.meta.url), 'utf8'));

  assert.match(source, /if \(this\.detached\) return false;/, 'the band paints again while detached');

  const surface = Object.create(StageSurface.prototype);
  surface.out = { write: () => {} };
  surface.mouseCaptured = true;
  surface.detached = false;
  let invalidated = 0;
  surface.stage = { invalidate: () => { invalidated++; } };

  surface.releaseMouse();
  assert.equal(surface.detached, true, 'handing the wheel over did not detach the band');

  surface.captureMouse();
  assert.equal(surface.detached, false, 'coming back did not reattach the band');
  assert.equal(invalidated, 1, 'the diff was trusted after the terminal scrolled — every cached row is stale');
});
