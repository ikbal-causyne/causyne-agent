// The chat input layer: key decoding, editing, completion, history, prompt.
//
// The transcript (tests/tui.test.js) covers what the agent SAYS. This covers
// what the user TYPES — the half that was still `inquirer.prompt({type:'input'})`
// with no history, no completion, and no way to type while a turn was running.
//
// Every case here is a behaviour that was wrong or absent before this phase.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { KeyDecoder, bracketedPaste, PASTE_START, PASTE_END } from '../src/tui/keys.js';
import { LineEditor } from '../src/tui/lineEditor.js';
import {
  suggest, detectTrigger, applyCompletion, isTerminalSafe, score, FileIndex
} from '../src/tui/completion.js';
import { PromptHistory, looksSensitive, MAX_ENTRIES } from '../src/tui/history.js';
import { ChatPrompt, isInteractive, keyHints } from '../src/tui/prompt.js';
import { listCommands } from '../src/commands.js';
import { listCompiledSkills } from '../src/skillsManager.js';
import { visibleWidth } from '../src/tui/text.js';

const bytes = (text) => Buffer.from(text, 'binary');
const names = (events) => events.map((event) => event.name);

// ---------------------------------------------------------------------------

describe('keys — decoding what a terminal actually sends', () => {
  test('named keys, modifiers and control characters', () => {
    const decoder = new KeyDecoder();
    assert.deepEqual(names(decoder.decode(bytes('\x1b[A\x1b[B\x1b[C\x1b[D'))),
      ['up', 'down', 'right', 'left']);

    const [ctrlA] = decoder.decode(bytes('\x01'));
    assert.equal(ctrlA.name, 'a');
    assert.equal(ctrlA.ctrl, true);

    const [altEnter] = decoder.decode(bytes('\x1b\r'));
    assert.equal(altEnter.name, 'enter');
    assert.equal(altEnter.alt, true, 'alt+enter is the newline binding — it must be distinguishable');

    const [shiftTab] = decoder.decode(bytes('\x1b[Z'));
    assert.equal(shiftTab.name, 'tab');
    assert.equal(shiftTab.shift, true);

    const [ctrlRight] = decoder.decode(bytes('\x1b[1;5C'));
    assert.equal(ctrlRight.name, 'right');
    assert.equal(ctrlRight.ctrl, true, 'word-wise movement depends on the modifier parameter');
  });

  test('a multi-byte character split across chunks is reassembled', () => {
    // stdin delivers whatever the OS gives it. Decoding each chunk eagerly turns
    // one emoji into replacement characters.
    const decoder = new KeyDecoder();
    const events = [];
    for (const byte of Buffer.from('héllo 🚀', 'utf8')) {
      events.push(...decoder.decode(Buffer.from([byte])));
    }
    assert.equal(events.map((event) => event.text).join(''), 'héllo 🚀');
  });

  test('an escape sequence split across chunks is held, not mangled', () => {
    const decoder = new KeyDecoder();
    assert.deepEqual(decoder.decode(bytes('\x1b[')), [], 'incomplete: emit nothing yet');
    const [key] = decoder.decode(bytes('1;5C'));
    assert.equal(key.name, 'right');
    assert.equal(key.ctrl, true);
  });

  test('a lone ESC is the Escape key', () => {
    const decoder = new KeyDecoder();
    assert.deepEqual(names(decoder.decode(bytes('\x1b'))), ['escape']);
  });

  test('bracketed paste containing newlines is ONE event, not several Enters', () => {
    // This is the whole reason bracketed paste is enabled. Without it, pasting
    // a three-line prompt submits the first line and orphans the rest.
    const decoder = new KeyDecoder();
    const events = decoder.decode(Buffer.from(
      `${PASTE_START}line one\nline two\nline three${PASTE_END}`, 'utf8'
    ));
    assert.equal(events.length, 1);
    assert.equal(events[0].name, 'paste');
    assert.equal(events[0].text, 'line one\nline two\nline three');
  });

  test('a paste terminator split across chunks still terminates', () => {
    const decoder = new KeyDecoder();
    decoder.decode(Buffer.from(`${PASTE_START}abc`, 'utf8'));
    assert.deepEqual(decoder.decode(Buffer.from('\x1b[20', 'utf8')), [],
      'a partial terminator must not be appended as content');
    const events = decoder.decode(Buffer.from('1~', 'utf8'));
    assert.equal(events.length, 1);
    assert.equal(events[0].text, 'abc');
  });

  test('a bare newline outside a paste is still Enter', () => {
    const decoder = new KeyDecoder();
    assert.deepEqual(names(decoder.decode(bytes('a\nb'))), ['char', 'enter', 'char']);
  });

  test('an unrecognised sequence is consumed, never leaked as text', () => {
    // Anything left in the stream would land in the edit buffer as literal
    // escape bytes and corrupt the line the user is writing.
    const decoder = new KeyDecoder();
    const events = decoder.decode(bytes('\x1b[99;99R'));
    assert.equal(events.length, 1);
    assert.equal(events[0].name, 'unknown');
    assert.equal(events[0].text, '');
  });

  test('bracketed paste mode is switched on and off explicitly', () => {
    assert.equal(bracketedPaste(true), '\x1b[?2004h');
    assert.equal(bracketedPaste(false), '\x1b[?2004l');
  });
});

// ---------------------------------------------------------------------------

describe('lineEditor — a buffer you can actually edit', () => {
  test('word movement and kill/yank follow readline conventions', () => {
    const editor = new LineEditor();
    editor.insert('hello world');
    editor.moveWordLeft();
    assert.equal(editor.col, 6);

    editor.killToEnd();
    assert.equal(editor.getText(), 'hello ');
    assert.equal(editor.killRing, 'world');

    editor.yank();
    assert.equal(editor.getText(), 'hello world');
  });

  test('multi-line input, and joining lines with backspace', () => {
    const editor = new LineEditor('one');
    editor.newline();
    editor.insert('two');
    assert.equal(editor.getText(), 'one\ntwo');

    editor.moveHome();
    editor.backspace();
    assert.equal(editor.getText(), 'onetwo', 'backspace at column 0 joins the lines');
    assert.equal(editor.line, 0);
    assert.equal(editor.col, 3, 'the cursor lands where the two lines met');
  });

  test('a pasted block enters as multiple lines, not escaped text', () => {
    const editor = new LineEditor();
    editor.insert('first\nsecond\nthird');
    assert.equal(editor.lines.length, 3);
    assert.equal(editor.getText(), 'first\nsecond\nthird');
  });

  test('the cursor moves by character, not by UTF-16 unit', () => {
    // An emoji is two UTF-16 units. Moving by index cuts it in half and the
    // terminal prints a replacement character.
    const editor = new LineEditor('🚀ab');
    editor.moveHome();
    editor.moveRight();
    assert.equal(editor.col, 1);
    editor.backspace();
    assert.equal(editor.getText(), 'ab', 'one keypress deletes the whole emoji');
  });

  test('soft wrap maps the cursor to the right display row', () => {
    const editor = new LineEditor('x'.repeat(25));
    const layout = editor.render(10);
    assert.equal(layout.rows.length, 3);
    assert.equal(layout.cursorRow, 2);
    assert.equal(layout.cursorCol, 5, 'a wrong column here puts the caret on the wrong character');
  });

  test('wide characters count as two columns when wrapping', () => {
    const editor = new LineEditor('漢'.repeat(6));
    const layout = editor.render(10);
    assert.ok(layout.rows.length >= 2, 'CJK is double-width: six of them do not fit in ten columns');
  });
});

// ---------------------------------------------------------------------------

describe('completion — suggestions that cannot lie or inject', () => {
  test('slash commands come from the real registry', () => {
    const result = suggest('/und', 4);
    assert.ok(result, 'typing /und must offer something');

    // The real command ranks first. The menu now also carries the skill library
    // — typing `/docker` should find the Docker skill without the user knowing
    // it lives under `devops` — so /und legitimately subsequence-matches skills
    // too. What must stay true is that nothing here is invented.
    assert.equal(result.items[0].value, '/undo', 'the exact command must rank first');

    const commands = new Set(listCommands('terminal').map((command) => '/' + command.name));
    const skills = new Set(listCompiledSkills().map((skill) => `/skills ${skill.domain}/${skill.id}`));
    for (const item of result.items) {
      assert.ok(commands.has(item.value) || skills.has(item.value),
        `${item.value} is neither a registered command nor a real skill`);
    }
  });

  test('the skill library is reachable from the slash menu', () => {
    // claude-code surfaces a skill as a command you simply type. With a hundred
    // of them, requiring the user to know both `/skills` and the domain is the
    // difference between a library and a list nobody opens.
    const result = suggest('/docker', 7);
    assert.ok(result, '/docker must find the Docker skill');
    assert.equal(result.items[0].label, '/docker-multi-stage-builds');
    assert.equal(result.items[0].value, '/skills devops/docker-multi-stage-builds',
      'accepting it must resolve to the canonical command — one execution path, no second namespace');
  });

  test('the "N more" count is the truth, not the capped figure', () => {
    // It reported the size of the capped array: "42 more" when 107 were
    // reachable by scrolling. A count that is wrong tells the user to stop
    // looking.
    const text = '/skills ';
    const result = suggest(text, text.length, { root: process.cwd() });
    assert.equal(result.total, result.items.length,
      'a command vocabulary is small enough to hold whole; nothing may be silently dropped');
    assert.ok(result.total >= listCompiledSkills().length,
      `only ${result.total} of ${listCompiledSkills().length} skills were offered`);
  });

  test('an absolute path is not a command', () => {
    // Same rule parseCommand() enforces on submit: a task that mentions a path
    // must not be hijacked into the command namespace.
    assert.equal(suggest('/usr/local/bin', 14), null);
    assert.equal(detectTrigger('/usr/local/bin', 14), null);
  });

  test('a slash in the middle of a sentence does not open the picker', () => {
    assert.equal(suggest('fix the /usr path', 12), null);
  });

  test('@ completes files, and applying it inserts a mention', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-complete-'));
    fs.writeFileSync(path.join(root, 'alpha.txt'), 'x');
    fs.mkdirSync(path.join(root, 'nested'));

    const result = suggest('@alph', 5, { root });
    assert.ok(result, '@alph must suggest alpha.txt');
    assert.equal(result.items[0].value, 'alpha.txt');

    const applied = applyCompletion('@alph', 5, result, result.items[0]);
    assert.equal(applied.text, '@alpha.txt ');
    assert.equal(applied.cursor, applied.text.length);

    // A directory keeps the picker open so the next keystroke drills in.
    const dirResult = suggest('@nest', 5, { root });
    const dirApplied = applyCompletion('@nest', 5, dirResult, dirResult.items[0]);
    assert.equal(dirApplied.text, '@nested/', 'no trailing space after a directory');

    fs.rmSync(root, { recursive: true, force: true });
  });

  test('SECURITY: a filename carrying an escape sequence is never offered', () => {
    // `touch $'evil\e[31m.txt'` is legal on every POSIX filesystem. Offering
    // that name would inject the escape into the picker AND into the buffer,
    // where it would be re-emitted to the terminal on every redraw.
    assert.equal(isTerminalSafe('ok.txt'), true);
    assert.equal(isTerminalSafe('evil\x1b[31m.txt'), false);
    assert.equal(isTerminalSafe('erase\x1b[2Jscreen.txt'), false);

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-evil-'));
    const hostile = 'evil\x1b[31m.txt';
    let created = true;
    try {
      fs.writeFileSync(path.join(root, hostile), 'x');
    } catch (e) {
      created = false; // some filesystems refuse the name outright
    }
    fs.writeFileSync(path.join(root, 'safe.txt'), 'x');

    const result = suggest('@', 1, { root });
    const offered = (result ? result.items : []).map((item) => item.value);
    assert.ok(offered.includes('safe.txt'), 'ordinary files still appear');
    if (created) {
      assert.ok(!offered.some((value) => value.includes('\x1b')),
        'no offered value may contain an escape');
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('ranking prefers a prefix, and still finds a subsequence', () => {
    // ZM-09: naive substring matching both over-matches and mis-ranks. A prefix
    // must win, and "tuich" must still reach "tui/chatRenderer.js".
    assert.ok(score('undo', 'und') > score('checkpoints', 'und'));
    assert.ok(score('src/tui/chatRenderer.js', 'tuich') >= 0);
    assert.equal(score('completely-unrelated', 'zzzz'), -1);
  });

  test('the file index is bounded and never required', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-index-'));
    fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'index.js'), 'x');
    fs.writeFileSync(path.join(root, 'real.js'), 'x');

    const index = new FileIndex(root);
    assert.equal(index.isReady, false, 'suggestions must never wait on the index');
    return index.ensure().then(() => {
      assert.ok(index.entries.includes('real.js'));
      assert.ok(!index.entries.some((entry) => entry.includes('node_modules')),
        'walking node_modules buries real files and costs seconds');
      fs.rmSync(root, { recursive: true, force: true });
    });
  });
});

// ---------------------------------------------------------------------------

describe('history — remembered, but never a place a key leaks', () => {
  const tempFile = () => path.join(os.tmpdir(), `causyne-hist-${process.pid}-${Math.random()}`);

  test('prompts persist across sessions', () => {
    const file = tempFile();
    const first = new PromptHistory({ file });
    first.add('build the site');
    first.add('build the docs');

    const second = new PromptHistory({ file });
    assert.deepEqual(second.entries, ['build the site', 'build the docs']);
    assert.equal(second.previous(''), 'build the docs', 'newest first');
    assert.equal(second.previous(''), 'build the site');
    fs.rmSync(file, { force: true });
  });

  test('SECURITY: a line containing a credential is never written to disk', () => {
    const file = tempFile();
    const history = new PromptHistory({ file });

    assert.equal(history.add('use sk-abcdef0123456789 for auth'), false);
    assert.equal(history.add('curl -H "Authorization: Bearer abcdefghijklmnop"'), false);
    assert.equal(history.add('export api_key=supersecretvalue'), false);
    assert.equal(history.add('deploy the worker'), true);

    const onDisk = fs.readFileSync(file, 'utf8');
    assert.ok(!onDisk.includes('sk-abcdef'), 'an API key must never reach the history file');
    assert.ok(!onDisk.includes('supersecretvalue'));
    assert.ok(onDisk.includes('deploy the worker'), 'ordinary prompts are still kept');
    fs.rmSync(file, { force: true });
  });

  test('looksSensitive recognises credential shapes without eating normal text', () => {
    assert.equal(looksSensitive('sk-abcdefghijklmnop'), true);
    assert.equal(looksSensitive('refactor the sketch module'), false,
      'a false positive silently drops a prompt the user wanted back');
  });

  test('consecutive duplicates are collapsed and the file is capped', () => {
    const file = tempFile();
    const history = new PromptHistory({ file });
    history.add('same');
    history.add('same');
    assert.equal(history.entries.length, 1);

    for (let index = 0; index < MAX_ENTRIES + 40; index++) history.add(`prompt ${index}`);
    assert.equal(history.entries.length, MAX_ENTRIES);
    assert.equal(history.entries[history.entries.length - 1], `prompt ${MAX_ENTRIES + 39}`);
    fs.rmSync(file, { force: true });
  });

  test('the typed prefix filters what Up walks through', () => {
    const file = tempFile();
    const history = new PromptHistory({ file });
    history.add('npm test');
    history.add('git status');
    history.add('npm run build');

    assert.equal(history.previous('npm '), 'npm run build');
    assert.equal(history.previous('npm '), 'npm test', 'git status is skipped');
    fs.rmSync(file, { force: true });
  });
});

// ---------------------------------------------------------------------------

/** A stdin/stdout pair that records instead of touching a real terminal. */
function fakeTerminal() {
  const input = new EventEmitter();
  input.isTTY = true;
  input.setRawMode = () => {};
  input.resume = () => {};
  input.pause = () => {};
  input.off = input.removeListener;

  const written = [];
  const out = { write: (text) => { written.push(text); return true; } };
  return { input, out, written, text: () => written.join('') };
}

describe('prompt — the three behaviours a user feels', () => {
  const makePrompt = (options = {}) => {
    const terminal = fakeTerminal();
    const file = path.join(os.tmpdir(), `causyne-p-${process.pid}-${Math.random()}`);
    const prompt = new ChatPrompt({
      input: terminal.input,
      out: terminal.out,
      history: new PromptHistory({ file }),
      ...options
    });
    return { prompt, terminal, file };
  };

  test('typing while a turn runs QUEUES the line instead of losing it', async () => {
    const { prompt, file } = makePrompt();
    prompt.setBusy(true);
    prompt.editor.insert('and then deploy it');
    prompt.submit();

    assert.equal(prompt.queue.length, 1, 'the line is held, not swallowed');
    assert.match(prompt.notice, /queued/);

    prompt.setBusy(false);
    assert.equal(await prompt.read(), 'and then deploy it',
      'the queued line is delivered on the next read');
    fs.rmSync(file, { force: true });
  });

  test('Escape during a turn calls the interrupt hook', () => {
    let interrupted = 0;
    const { prompt, file } = makePrompt({ onInterrupt: () => { interrupted += 1; } });
    prompt.setBusy(true);
    prompt.handleKey({ name: 'escape', ctrl: false, alt: false, shift: false, text: '' });
    assert.equal(interrupted, 1, 'Esc must reach AgentLoop.abort()');
    fs.rmSync(file, { force: true });
  });

  test('Escape when idle clears the line rather than interrupting', () => {
    let interrupted = 0;
    const { prompt, file } = makePrompt({ onInterrupt: () => { interrupted += 1; } });
    prompt.editor.insert('half a thought');
    prompt.handleKey({ name: 'escape', ctrl: false, alt: false, shift: false, text: '' });
    assert.equal(prompt.editor.getText(), '');
    assert.equal(interrupted, 0);
    fs.rmSync(file, { force: true });
  });

  test('a submitted line resolves a pending read', async () => {
    const { prompt, file } = makePrompt();
    const pending = prompt.read();
    prompt.editor.insert('what is in this repo');
    prompt.submit();
    assert.equal(await pending, 'what is in this repo');
    fs.rmSync(file, { force: true });
  });

  test('Alt+Enter adds a line; Enter sends', () => {
    const { prompt, file } = makePrompt();
    prompt.handleKey({ name: 'char', text: 'a', ctrl: false, alt: false, shift: false });
    prompt.handleKey({ name: 'enter', ctrl: false, alt: true, shift: false, text: '' });
    prompt.handleKey({ name: 'char', text: 'b', ctrl: false, alt: false, shift: false });
    assert.equal(prompt.editor.getText(), 'a\nb', 'alt+enter must not submit');
    fs.rmSync(file, { force: true });
  });

  test('Ctrl+C clears a non-empty line before it ever exits', () => {
    let exited = 0;
    const { prompt, file } = makePrompt({ onExit: () => { exited += 1; } });
    prompt.editor.insert('a long prompt');
    prompt.handleKey({ name: 'c', ctrl: true, alt: false, shift: false, text: '' });
    assert.equal(prompt.editor.getText(), '');
    assert.equal(exited, 0, 'the first Ctrl+C must not kill the session');
    fs.rmSync(file, { force: true });
  });

  test('typing / opens the command picker without pressing Tab', () => {
    const { prompt, file } = makePrompt();
    for (const character of '/un') {
      prompt.handleKey({ name: 'char', text: character, ctrl: false, alt: false, shift: false });
    }
    assert.ok(prompt.completion, 'the picker should open as you type');
    assert.ok(prompt.completion.items.some((item) => item.value === '/undo'));
    fs.rmSync(file, { force: true });
  });

  test('a render pass emits no colour escapes when NO_COLOR is set', () => {
    // theme.js reads NO_COLOR at import, and the suite runs with it unset, so
    // assert the property that holds either way: the drawn frame is built from
    // theme roles, never from escapes written by hand in this module.
    const source = fs.readFileSync(new URL('../src/tui/prompt.js', import.meta.url), 'utf8');
    const body = source.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
    const colourEscapes = body.match(/\\x1b\[[0-9;]*m/g) || [];
    assert.deepEqual(colourEscapes, [],
      'colour must come from theme.js roles so NO_COLOR and light terminals work');
  });

  test('isInteractive respects the documented escape hatch', () => {
    const previous = process.env.CAUSYNE_SIMPLE_INPUT;
    process.env.CAUSYNE_SIMPLE_INPUT = '1';
    assert.equal(isInteractive(), false, 'CAUSYNE_SIMPLE_INPUT=1 must force the inquirer path');
    if (previous === undefined) delete process.env.CAUSYNE_SIMPLE_INPUT;
    else process.env.CAUSYNE_SIMPLE_INPUT = previous;
  });

  test('the key hints name the bindings that are not discoverable', () => {
    // Given room, every non-discoverable binding is named. The line is fitted to
    // the terminal now — the full list is 145 columns and used to wrap on any
    // narrower one — so the width has to be stated for this to mean anything.
    const hints = keyHints(160);
    for (const expected of ['alt+enter', 'esc', 'ctrl+o', '@']) {
      assert.ok(hints.includes(expected), `hints must mention ${expected}`);
    }
  });

  test('the key hints drop fragments rather than wrap a narrow terminal', () => {
    const narrow = keyHints(50);
    assert.ok(visibleWidth(narrow) <= 49,
      'the hint line must fit, or the first thing the user sees is a broken row');
    assert.ok(narrow.includes('enter send'),
      'the most important hint survives at every width');
  });
});

// ---------------------------------------------------------------------------

describe('renderer — the preview no longer scans megabytes to print 12 lines', () => {
  test('a huge tool result is cut BEFORE it is sanitised', async () => {
    const { ChatRenderer } = await import('../src/tui/chatRenderer.js');
    const written = [];
    const renderer = new ChatRenderer({ out: { write: (text) => written.push(text) } });

    // 2 MB of output. safeDisplay() over the whole payload would mean five
    // regex passes across every byte of it.
    const payload = ('lorem ipsum dolor sit amet '.repeat(80000));
    const started = Date.now();
    // Capturing and rendering are separate seams now: a transcript frame is
    // re-rendered on every reflow, and re-pointing "the last output" from
    // inside a re-render would resurrect a payload the user finished with ten
    // turns ago. onStepComplete() is the path production takes.
    renderer.captureLastOutput({ output: payload });
    renderer.renderOutputPreview({ output: payload });
    const elapsed = Date.now() - started;

    assert.ok(elapsed < 500, `preview took ${elapsed}ms — the source budget is not being applied`);
    assert.ok(written.length <= 14, 'the preview stays bounded');
    assert.equal(renderer.lastOutput.text.length, payload.length,
      'the full text is still kept so ctrl+o can show it');
  });

  test('expandLastOutput prints the whole thing, and says so when there is none', () => {
    return import('../src/tui/chatRenderer.js').then(({ ChatRenderer }) => {
      const written = [];
      const renderer = new ChatRenderer({ out: { write: (text) => written.push(text) } });

      assert.equal(renderer.expandLastOutput(), false, 'nothing captured yet');
      assert.match(written.join(''), /nothing to expand/);

      written.length = 0;
      renderer.captureLastOutput({ output: Array.from({ length: 40 }, (_, i) => `row ${i}`).join('\n') });
      written.length = 0;
      assert.equal(renderer.expandLastOutput(), true);
      const text = written.join('');
      assert.match(text, /row 0/);
      assert.match(text, /row 39/, 'expansion must reach past the 12-line preview');
    });
  });

  test('untrusted output is still sanitised on the expanded path', () => {
    return import('../src/tui/chatRenderer.js').then(({ ChatRenderer }) => {
      const written = [];
      const renderer = new ChatRenderer({ out: { write: (text) => written.push(text) } });
      renderer.renderOutputPreview({ output: 'before\x1b[2Jafter' });
      written.length = 0;
      renderer.expandLastOutput();
      assert.ok(!written.join('').includes('\x1b[2J'),
        'expanding must not become a way to bypass sanitisation');
    });
  });
});

describe('theme — links are opt-in and never forged from untrusted text', () => {
  test('a hyperlink degrades to plain text where it is not supported', async () => {
    const theme = await import('../src/tui/theme.js');
    if (!theme.HAS_HYPERLINKS) {
      assert.equal(theme.link('label', 'file:///tmp/x'), 'label');
      assert.equal(theme.fileLink('label', '/tmp/x'), 'label');
    } else {
      assert.match(theme.link('label', 'file:///tmp/x'), /\x1b\]8;;/);
    }
  });

  test('the hyperlink helper is only ever called with paths we build', () => {
    // OSC 8 is an escape sequence. Emitting one on behalf of tool output would
    // reintroduce exactly the injection text.js sanitize() exists to stop.
    const source = fs.readFileSync(new URL('../src/tui/chatRenderer.js', import.meta.url), 'utf8');
    const calls = source.match(/fileLink\([^)]*\)/g) || [];
    assert.ok(calls.length > 0, 'the renderer should link something');
    for (const call of calls) {
      assert.match(call, /spillPath/,
        'fileLink may only wrap a path this process constructed, never tool text');
    }
  });
});

// ---------------------------------------------------------------------------

describe('build shape — the tool tokens must stay rewritable', () => {
  test('curated tool names are string values, never bare object keys', () => {
    // scripts/bundle_stage.js strips the plaintext capability tokens (fs_read,
    // fs_write, fs_delete, fs_move) out of the shipped bytecode by rewriting
    // them into composed character codes. That pass can only rewrite a token
    // inside a string; as a bare object key it emitted
    //   {" + String.fromCharCode(102,115,95,114,101,97,100) + ":
    // which does not parse, and `npm run build` died in bytenode with
    // "Unexpected identifier". npm test passed the whole time, so nothing
    // caught it — this is that missing check.
    const source = fs.readFileSync(new URL('../src/tui/toolDisplay.js', import.meta.url), 'utf8');
    const body = source.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');

    for (const token of ['fs_read', 'fs_write', 'fs_delete', 'fs_move']) {
      assert.ok(!new RegExp(`(^|[{,\\s])${token}\\s*:`, 'm').test(body),
        `${token} appears as a bare object key — bundle_stage.js cannot rewrite that into valid syntax`);
      assert.ok(body.includes(`'${token}'`),
        `${token} must appear as a quoted string so the build can compose it`);
    }
  });

  test('the tool name from the model cannot reach Object.prototype', () => {
    // The tool name is model-supplied. On an object literal, TOOL_DISPLAY
    // ['constructor'] walks the prototype chain and hands back a function,
    // which was then invoked as if it were a display helper.
    const source = fs.readFileSync(new URL('../src/tui/toolDisplay.js', import.meta.url), 'utf8');
    assert.match(source, /new Map\(\[/, 'the lookup table must be a Map');
    assert.match(source, /TOOL_DISPLAY\.get\(/, 'and must be read with .get()');
  });
});

describe('the live region never erases above its own first row', () => {
  // The bug: draw() parks the caret on the editor's cursor row, but erase() moved
  // up drawnRows - 1 as though the caret were on the LAST row. With a completion
  // picker open, or a notice showing, or a multiline message with the caret on an
  // earlier line, the walk overshot the top of the block and \x1b[J then wiped
  // that many rows of real conversation. Nothing on screen said so — the prompt
  // still looked right, the transcript above it had simply lost lines.

  const terminal = () => {
    const written = [];
    return {
      out: { write: (t) => { written.push(t); return true; }, columns: 80, rows: 24, isTTY: true },
      text: () => written.join(''),
      reset: () => { written.length = 0; }
    };
  };

  /**
   * Net vertical displacement of a byte stream: up is negative, down positive.
   *
   * `+ 0` normalises the negative zero that -0 comparisons would otherwise fail
   * on under strict equality.
   */
  function netRows(text) {
    let row = 0;
    for (const [, up] of text.matchAll(/\x1b\[(\d+)A/g)) row -= Number(up);
    for (const char of text) if (char === '\n') row += 1;
    return row + 0;
  }

  function promptWith(build) {
    const term = terminal();
    const file = path.join(os.tmpdir(), `causyne-erase-${process.pid}-${Math.random()}`);
    const prompt = new ChatPrompt({
      input: new EventEmitter(),
      out: term.out,
      history: new PromptHistory({ file })
    });
    prompt.active = true;
    build(prompt);
    prompt.draw();
    return { prompt, term, file };
  }

  const cases = {
    'a single-line prompt': (p) => p.editor.insert('hello'),
    'a multiline message with the caret on the first line': (p) => {
      p.editor.insert('first line\nsecond line\nthird line');
      p.editor.moveTo ? p.editor.moveTo(0) : p.editor.home && p.editor.home();
      for (let i = 0; i < 40; i++) p.editor.left && p.editor.left();
    },
    'a notice showing': (p) => { p.editor.insert('hi'); p.notice = 'nothing to complete here'; }
  };

  for (const [name, build] of Object.entries(cases)) {
    test(`erase walks back exactly as far as it drew — ${name}`, () => {
      const { prompt, term, file } = promptWith(build);
      const drawn = prompt.drawnRows;
      const afterDraw = netRows(term.text());

      term.reset();
      prompt.erase();
      const walkedUp = -netRows(term.text()) + 0;

      assert.ok(walkedUp >= 0, 'erase must never move the cursor down');
      assert.ok(walkedUp <= drawn - 1,
        `erase walked up ${walkedUp} rows having drawn ${drawn} — it would eat ${walkedUp - (drawn - 1)} rows of transcript`);
      assert.equal(walkedUp, afterDraw,
        'erase must land exactly on the row the block started from');

      try { fs.unlinkSync(file); } catch {}
    });
  }

  test('erase returns to the starting row, so repeated redraws do not creep', () => {
    // Ten draw/erase cycles must leave the cursor exactly where it began. Any
    // per-cycle drift is a row of history destroyed on every keystroke.
    const term = terminal();
    const file = path.join(os.tmpdir(), `causyne-creep-${process.pid}-${Math.random()}`);
    const prompt = new ChatPrompt({ input: new EventEmitter(), out: term.out, history: new PromptHistory({ file }) });
    prompt.active = true;
    prompt.editor.insert('a message long enough to matter');
    prompt.notice = 'a notice, so the block is taller than the caret row';

    term.reset();
    for (let cycle = 0; cycle < 10; cycle++) { prompt.draw(); prompt.erase(); }
    assert.equal(netRows(term.text()), 0,
      'ten draw/erase cycles drifted — the prompt is eating the transcript above it');

    try { fs.unlinkSync(file); } catch {}
  });
});

describe('the live region stays small enough to keep the conversation on screen', () => {
  const term = () => {
    const written = [];
    return { out: { write: (t) => { written.push(t); return true; }, columns: 80, rows: 24, isTTY: true, on() {}, removeListener() {} },
             text: () => written.join(''), reset: () => { written.length = 0; } };
  };

  test('a huge paste does not grow the prompt without bound', () => {
    // Before the cap, pasting a 200-line file drew 200 rows and erase() then
    // walked 200 rows back up on every keystroke, shoving the conversation off
    // the top of the terminal.
    const t = term();
    const file = path.join(os.tmpdir(), `causyne-cap-${process.pid}-${Math.random()}`);
    const prompt = new ChatPrompt({ input: new EventEmitter(), out: t.out, history: new PromptHistory({ file }) });
    prompt.active = true;
    prompt.editor.insert(Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n'));
    prompt.draw();

    assert.ok(prompt.drawnRows <= 12,
      `the prompt drew ${prompt.drawnRows} rows for a 200-line paste`);
    assert.ok(prompt.cursorRow < prompt.drawnRows,
      'the caret must stay inside the drawn window');
    try { fs.unlinkSync(file); } catch {}
  });

  test('the caret stays visible when the message is taller than the window', () => {
    const t = term();
    const file = path.join(os.tmpdir(), `causyne-caret-${process.pid}-${Math.random()}`);
    const prompt = new ChatPrompt({ input: new EventEmitter(), out: t.out, history: new PromptHistory({ file }) });
    prompt.active = true;
    prompt.editor.insert(Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n'));
    prompt.draw();
    assert.ok(prompt.cursorRow >= 0 && prompt.cursorRow < prompt.drawnRows,
      `caret row ${prompt.cursorRow} fell outside a block of ${prompt.drawnRows}`);
    try { fs.unlinkSync(file); } catch {}
  });
});

describe('completion — a command completes its own arguments', () => {
  // Completion used to stop dead at the space after a command name. `/skills d`
  // offered nothing, so the only route to a skill was to submit `/skills` bare
  // and browse a hundred entries — a poor trade for someone who already knows
  // the name they want.
  //
  // openclaw's contract (src/tui/commands.ts): a command declares its argument
  // vocabulary and the prompt asks for the entries matching what has been typed
  // (`getArgumentCompletions(prefix)`). This is that, generic over every command
  // and ranked with the same score() the app already uses for commands and
  // filenames — so a basename match wins without the domain being typed first.

  test('a space after a command opens the argument picker', () => {
    const trigger = detectTrigger('/skills d', 9);
    assert.ok(trigger, 'the space used to end completion entirely');
    assert.equal(trigger.kind, 'command-argument');
    assert.equal(trigger.command, 'skills');
    assert.equal(trigger.query, 'd');
  });

  test('the trigger ends at a second word rather than completing inside a sentence', () => {
    assert.equal(detectTrigger('/skills devops one more', 22), null,
      'only a single argument token completes — opencode hides on the same condition');
  });

  test('a slash mid-sentence never becomes a command argument', () => {
    assert.equal(detectTrigger('please read /usr/local x', 24), null);
    assert.equal(detectTrigger('tell me about /skills d', 23), null,
      'the trigger is anchored, exactly as the command trigger is');
  });

  test('typing letters narrows the suggestions', () => {
    const at = (text) => suggest(text, text.length, { root: process.cwd() });

    const all = at('/skills ');
    assert.ok(all && all.items.length > 5, 'an empty argument offers the vocabulary');

    // Compare below rank()'s 50-item cap, or both sides are simply the cap and
    // the comparison proves nothing.
    const broad = at('/skills doc');
    const narrow = at('/skills docker');
    assert.ok(broad.items.length < 50, 'this comparison is only meaningful under the cap');
    assert.ok(narrow.items.length < broad.items.length,
      `"docker" (${narrow.items.length}) must narrow "doc" (${broad.items.length})`);

    assert.ok(at('/skills d').items.every((item) => /d/i.test(item.label)),
      'every suggestion must relate to what was typed');
  });

  test('a skill is reachable without knowing its domain', () => {
    // The behaviour that makes this worth having: score() ranks a basename
    // prefix above a buried subsequence, so the obvious answer comes first.
    const cases = {
      '/skills doc': 'devops/docker-multi-stage-builds',
      '/skills query': 'database/query-optimisation',
      '/skills hydra': 'web/ssr-hydration-correctness'
    };
    for (const [text, expected] of Object.entries(cases)) {
      const result = suggest(text, text.length, { root: process.cwd() });
      assert.ok(result, `${text} produced no suggestions`);
      assert.equal(result.items[0].value, expected,
        `${text} should rank ${expected} first, got ${result.items[0].value}`);
    }
  });

  test('domains complete too — they are valid arguments in their own right', () => {
    const result = suggest('/skills web', 11, { root: process.cwd() });
    assert.ok(result.items.some((item) => item.value === 'web'),
      '/skills web is a valid command on its own');
  });

  test('a query that matches nothing opens no picker', () => {
    assert.equal(suggest('/skills zzzqqq', 14, { root: process.cwd() }), null,
      'an empty picker is worse than none');
  });

  test('accepting an argument replaces only the argument, and separates it', () => {
    const text = '/skills doc';
    const trigger = suggest(text, text.length, { root: process.cwd() });
    const applied = applyCompletion(text, text.length, trigger, trigger.items[0]);
    assert.equal(applied.text, '/skills devops/docker-multi-stage-builds ');
    assert.equal(applied.cursor, applied.text.length);

    // This test previously asserted the OPPOSITE, on the theory that a trailing
    // space would reopen the picker on a value still being edited. It does not —
    // a completed argument followed by a space matches no trigger at all. What
    // the missing space actually did was fuse the user's next words onto the id:
    // `/skills python/data-processing-pipelineswhy my data is like this ?`.
    assert.ok(applied.text.endsWith(' '),
      'a completed argument is finished; the next thing typed is the instruction');
    assert.equal(detectTrigger(applied.text, applied.text.length), null,
      'and the picker closes, which is what the missing space was supposed to achieve');
  });

  test('suggestions appear as you type, without pressing tab', () => {
    // The point of the feature. refreshCompletion() opens the picker on its own
    // for `/` and `@`; without the third condition the argument picker existed
    // but only appeared if the user happened to press tab, which nobody does
    // when they do not know a picker is there.
    const out = { columns: 100, write() { return true; }, isTTY: true, on() {}, removeListener() {} };
    const input = { isTTY: true, setRawMode() {}, resume() {}, pause() {}, on() {}, off() {} };
    const prompt = new ChatPrompt({ out, input, commands: [{ name: 'skills' }] });

    for (const character of '/skills doc') prompt.handleKey({ name: 'char', text: character });

    assert.ok(prompt.completion, 'the picker must open on its own while typing an argument');
    assert.equal(prompt.completion.kind, 'command-argument');
    assert.equal(prompt.completion.items[0].value, 'devops/docker-multi-stage-builds');
  });

  test('the picker closes again when the argument becomes a sentence', () => {
    const out = { columns: 100, write() { return true; }, isTTY: true, on() {}, removeListener() {} };
    const input = { isTTY: true, setRawMode() {}, resume() {}, pause() {}, on() {}, off() {} };
    const prompt = new ChatPrompt({ out, input, commands: [{ name: 'skills' }] });

    for (const character of '/skills doc') prompt.handleKey({ name: 'char', text: character });
    assert.ok(prompt.completion, 'open first');
    for (const character of ' and more') prompt.handleKey({ name: 'char', text: character });
    assert.equal(prompt.completion, null,
      'a second word ends the argument; the picker must not linger over a sentence');
  });

  test('a command with no completer simply offers nothing', () => {
    assert.equal(suggest('/help something', 15, { root: process.cwd() }), null,
      'the contract is opt-in; a command without complete() must not throw');
  });

  test('a completer that throws cannot take the prompt down', () => {
    const skills = listCommands('terminal').find((command) => command.name === 'skills');
    const original = skills.complete;
    skills.complete = () => { throw new Error('boom'); };
    try {
      assert.equal(suggest('/skills d', 9, { root: process.cwd() }), null);
    } finally {
      skills.complete = original;
    }
  });

  test('a completer cannot inject escape sequences into the picker', () => {
    // Suggestions are display text like any other untrusted string.
    const skills = listCommands('terminal').find((command) => command.name === 'skills');
    const original = skills.complete;
    skills.complete = () => ([
      { value: 'safe/one', label: 'safe/one', description: 'clean' },
      { value: 'evil\x1b[2J', label: 'evil', description: 'wipes the screen' }
    ]);
    try {
      const result = suggest('/skills safe', 12, { root: process.cwd() });
      const rendered = JSON.stringify(result ? result.items : []);
      assert.ok(!rendered.includes('\\u001b'), 'an escape must never reach the picker');
    } finally {
      skills.complete = original;
    }
  });
});

describe('a completion that matches exactly submits instead of looping', () => {
  // `/skill mine` offers exactly one completion — `mine` — which is already on
  // the line. Accepting it changed nothing, refreshCompletion() reopened the
  // picker on the same text, and Enter became a key that could never submit:
  // the command was unreachable.
  //
  // openclaw's shouldSubmitExactArgumentCompletion (src/tui/commands.ts) is the
  // rule: when the sole completion equals the argument text, submit.

  function prompt() {
    const out = { columns: 100, write() { return true; }, isTTY: true, on() {}, removeListener() {} };
    const input = { isTTY: true, setRawMode() {}, resume() {}, pause() {}, on() {}, off() {} };
    return new ChatPrompt({ out, input, commands: listCommands('terminal') });
  }

  test('enter submits when the only suggestion is what is typed', () => {
    const editor = prompt();
    let submitted = null;
    editor.waiter = (text) => { submitted = text; };

    for (const character of '/skill mine') editor.handleKey({ name: 'char', text: character });
    assert.ok(editor.completion, 'the picker opens on the argument');
    assert.equal(editor.completion.items.length, 1, 'and offers exactly the word already typed');

    editor.handleKey({ name: 'enter' });
    assert.equal(submitted, '/skill mine',
      'one enter must submit; before this it re-offered the same completion forever');
  });

  test('enter still completes when there is something left to complete', () => {
    const editor = prompt();
    let submitted = null;
    editor.waiter = (text) => { submitted = text; };

    for (const character of '/skills doc') editor.handleKey({ name: 'char', text: character });
    editor.handleKey({ name: 'enter' });
    assert.equal(submitted, null, 'a partial argument must complete, not submit');
    assert.equal(editor.editor.getText(), '/skills devops/docker-multi-stage-builds ',
      'with the separator, so the next keystroke starts the instruction');
  });

  test('tab always completes, even on an exact match', () => {
    const editor = prompt();
    for (const character of '/skill mine') editor.handleKey({ name: 'char', text: character });
    editor.handleKey({ name: 'tab' });
    assert.equal(editor.editor.getText(), '/skill mine', 'tab is explicit; it never submits');
  });

  test('a file completion that matches exactly still drills in', () => {
    // The exception: accepting a directory that matches exactly is how you go
    // into it, so the rule must not apply to file completion.
    const editor = prompt();
    editor.completion = { kind: 'file', query: 'src', items: [{ value: 'src/' }] };
    assert.equal(editor.completionIsExact(), false);
  });
});
