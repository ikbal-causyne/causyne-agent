import test from 'node:test';
import assert from 'node:assert/strict';
import { LineEditor } from '../src/tui/lineEditor.js';
import {
  normalizeClipboardText,
  copyToClipboard,
  copyChatboxInput,
  pasteIntoChatbox,
  extractLastAssistantTurn,
  runCopyCommand,
  runPasteCommand
} from '../src/tui/chatboxClipboard.js';
import { ChatPrompt } from '../src/tui/prompt.js';
import { runCommand } from '../src/commands.js';
import { emitOsc52Copy } from '../src/tui/clipboardSync.js';

test('normalizeClipboardText normalizes CRLF and classic CR to LF and strips bad control characters', () => {
  assert.equal(normalizeClipboardText('hello\r\nworld\r\n'), 'hello\nworld\n');
  assert.equal(normalizeClipboardText('line1\rline2'), 'line1\nline2');
  assert.equal(normalizeClipboardText('test\x00\x07\x1bvalue'), 'testvalue');
  assert.equal(normalizeClipboardText('tab\tand\nnewline'), 'tab\tand\nnewline');
  assert.equal(normalizeClipboardText(null), '');
});

test('LineEditor.insert normalizes Windows CRLF pastes without leaving carriage returns', () => {
  const editor = new LineEditor();
  editor.insert('first line\r\nsecond line\r\nthird line');
  assert.equal(editor.lines.length, 3);
  assert.equal(editor.getText(), 'first line\nsecond line\nthird line');
  assert.equal(editor.lines[0]?.join(''), 'first line');
  assert.equal(editor.lines[1]?.join(''), 'second line');
  assert.equal(editor.lines[2]?.join(''), 'third line');
});

test('LineEditor kill operations update killRing and yank can restore from killRing', () => {
  const editor = new LineEditor();
  editor.insert('hello brave new world');
  editor.moveWordLeft();
  editor.killToEnd();
  assert.equal(editor.getText(), 'hello brave new ');
  assert.equal(editor.killRing, 'world');
  editor.yank();
  assert.equal(editor.getText(), 'hello brave new world');
});

test('copyChatboxInput copies input and updates editor killRing and prompt notice', () => {
  let scheduled = false;
  const mockPrompt = {
    editor: new LineEditor('write test suite for causyne'),
    notice: '',
    scheduleDraw() { scheduled = true; }
  };

  const res = copyChatboxInput(mockPrompt);
  assert.equal(res.success, true);
  assert.equal(res.text, 'write test suite for causyne');
  assert.equal(mockPrompt.editor.killRing, 'write test suite for causyne');
  assert.equal(mockPrompt.notice, 'copied input to clipboard');
  assert.equal(scheduled, true);
});

test('copyChatboxInput fails cleanly when input is empty', () => {
  let scheduled = false;
  const mockPrompt = {
    editor: new LineEditor('   '),
    notice: '',
    scheduleDraw() { scheduled = true; }
  };

  const res = copyChatboxInput(mockPrompt);
  assert.equal(res.success, false);
  assert.equal(mockPrompt.notice, 'input is empty (nothing to copy)');
  assert.equal(scheduled, true);
});

test('pasteIntoChatbox inserts normalized text and provides user notice feedback', () => {
  let scheduled = false;
  let refreshed = false;
  const mockPrompt = {
    editor: new LineEditor('prefix '),
    notice: '',
    scheduleDraw() { scheduled = true; },
    refreshCompletion() { refreshed = true; }
  };

  const res = pasteIntoChatbox(mockPrompt, 'const x = 42;\r\nconst y = 84;\r\n');
  assert.equal(res.success, true);
  assert.equal(mockPrompt.editor.getText(), 'prefix const x = 42;\nconst y = 84;\n');
  assert.equal(mockPrompt.notice, 'pasted from clipboard');
  assert.equal(scheduled, true);
  assert.equal(refreshed, true);
});

test('extractLastAssistantTurn correctly finds the latest assistant response', () => {
  const loop = {
    messages: [
      { role: 'user', content: 'What is Causyne?' },
      { role: 'assistant', content: 'Causyne is an autonomous AI agent engine.' },
      { role: 'user', content: 'How do I use it?' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'You can run it via terminal CLI.' }
        ]
      }
    ]
  };

  assert.equal(extractLastAssistantTurn(loop), 'You can run it via terminal CLI.');
});

test('runCopyCommand handles /copy, /copy last, and /copy <text>', () => {
  const loop = {
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'Sovereign agent ready.' }
    ]
  };
  const mockPrompt = {
    editor: new LineEditor('local draft input'),
    notice: '',
    scheduleDraw() {}
  };

  // /copy input
  const resInput = runCopyCommand(['input'], { prompt: mockPrompt, loop });
  assert.equal(resInput.ok, true);
  assert.match(resInput.output, /Copied chatbox input/);

  // /copy last
  const resLast = runCopyCommand(['last'], { prompt: mockPrompt, loop });
  assert.equal(resLast.ok, true);
  assert.match(resLast.output, /Copied last assistant response/);

  // /copy <text>
  const resText = runCopyCommand(['npm', 'run', 'test'], { prompt: mockPrompt, loop });
  assert.equal(resText.ok, true);
  assert.match(resText.output, /Copied 12 characters/);
});

test('runPasteCommand pastes explicit argument or clipboard text into chatbox', () => {
  const mockPrompt = {
    editor: new LineEditor(),
    notice: '',
    scheduleDraw() {}
  };

  const res = runPasteCommand(['echo', 'hello'], { prompt: mockPrompt });
  assert.equal(res.ok, true);
  assert.equal(mockPrompt.editor.getText(), 'echo hello');
  assert.match(res.output, /Pasted 10 characters/);
});

test('slash commands /copy and /paste are registered in COMMANDS table', async () => {
  const mockPrompt = {
    editor: new LineEditor('command input test'),
    notice: '',
    scheduleDraw() {}
  };
  const ctx = { surface: 'terminal', prompt: mockPrompt, loop: { messages: [] } };

  const copyResult = await runCommand('copy', ['input'], ctx);
  assert.equal(copyResult.ok, true);

  const pasteResult = await runCommand('paste', ['pasted code'], ctx);
  assert.equal(pasteResult.ok, true);
  assert.match(mockPrompt.editor.getText(), /pasted code/);
});

test('ChatPrompt Alt+C copies input without clearing line', () => {
  let drawn = 0;
  const prompt = new ChatPrompt({
    out: { write() {}, columns: 80, on() {}, removeListener() {} },
    input: { setRawMode() {}, resume() {}, on() {}, off() {}, pause() {} }
  });
  prompt.draw = () => { drawn++; };
  prompt.editor.setText('my task query');

  prompt.handleKey({ name: 'c', alt: true });
  assert.equal(prompt.notice, 'copied input to clipboard');
  assert.equal(prompt.editor.getText(), 'my task query');
  assert.equal(prompt.editor.killRing, 'my task query');
});

test('ChatPrompt Alt+V pastes into prompt editor with notice', () => {
  let drawn = 0;
  const prompt = new ChatPrompt({
    out: { write() {}, columns: 80, on() {}, removeListener() {} },
    input: { setRawMode() {}, resume() {}, on() {}, off() {}, pause() {} }
  });
  prompt.draw = () => { drawn++; };
  prompt.editor.killRing = 'pasted snippet';

  // Alt+V attempts readClipboardSync or displays notice
  prompt.handleKey({ name: 'v', alt: true });
  assert.ok(prompt.notice.includes('clipboard'));
});

test('ChatPrompt Ctrl+C on non-empty editor copies to clipboard before clearing', () => {
  const prompt = new ChatPrompt({
    out: { write() {}, columns: 80, on() {}, removeListener() {} },
    input: { setRawMode() {}, resume() {}, on() {}, off() {}, pause() {} }
  });
  prompt.editor.setText('important prompt that would be lost');

  prompt.handleKey({ name: 'c', ctrl: true });
  assert.equal(prompt.editor.getText(), '');
  assert.equal(prompt.notice, 'cleared and copied to clipboard');
  assert.equal(prompt.editor.killRing, 'important prompt that would be lost');
});

test('emitOsc52Copy formats valid base64 escape sequence', () => {
  let emitted = '';
  const mockStream = {
    write(chunk: string) { emitted += chunk; return true; }
  };
  const success = emitOsc52Copy('test payload', mockStream as unknown as NodeJS.WritableStream);
  assert.equal(success, true);
  assert.equal(emitted, `\x1b]52;c;${Buffer.from('test payload').toString('base64')}\x07`);
});

test('LineEditor selection with Shift+Left/Right and getSelectedText', () => {
  const editor = new LineEditor('hello world');
  assert.equal(editor.hasSelection, false);

  // Shift+Left 5 times selects "world"
  for (let i = 0; i < 5; i++) editor.moveLeft(true);
  assert.equal(editor.hasSelection, true);
  assert.equal(editor.getSelectedText(), 'world');

  // Typing over selection replaces "world" with "earth"
  editor.insert('earth');
  assert.equal(editor.hasSelection, false);
  assert.equal(editor.getText(), 'hello earth');
});

test('LineEditor render formats selected characters with inverted reverse-video ANSI code', () => {
  const editor = new LineEditor('cat');
  editor.moveLeft(true); // selects 't'
  const rendered = editor.render(80, '');
  assert.ok(rendered.rows[0]?.includes('\x1b[7mt\x1b[27m'));
});

test('ChatPrompt Shift+Left selects text and Ctrl+C copies selection without clearing prompt', () => {
  const prompt = new ChatPrompt({
    out: { write() {}, columns: 80, on() {}, removeListener() {} },
    input: { setRawMode() {}, resume() {}, on() {}, off() {}, pause() {} }
  });
  prompt.editor.setText('select this word');
  
  // Shift+Left 4 times selects "word"
  for (let i = 0; i < 4; i++) {
    prompt.handleKey({ name: 'left', shift: true });
  }
  assert.equal(prompt.editor.hasSelection, true);
  assert.equal(prompt.editor.getSelectedText(), 'word');

  // Ctrl+C copies selection without clearing editor
  prompt.handleKey({ name: 'c', ctrl: true });
  assert.equal(prompt.editor.getText(), 'select this word');
  assert.match(prompt.notice, /copied selection \(4 chars\)/);
  assert.equal(prompt.editor.killRing, 'word');
});

test('ChatPrompt Ctrl+X cuts active selection to clipboard', () => {
  const prompt = new ChatPrompt({
    out: { write() {}, columns: 80, on() {}, removeListener() {} },
    input: { setRawMode() {}, resume() {}, on() {}, off() {}, pause() {} }
  });
  prompt.editor.setText('cut this word now');
  prompt.editor.moveWordLeft(false); // cursor before "now"
  prompt.handleKey({ name: 'left', shift: true }); // select space before now
  for (let i = 0; i < 4; i++) prompt.handleKey({ name: 'left', shift: true }); // select "word"
  assert.equal(prompt.editor.hasSelection, true);

  prompt.handleKey({ name: 'x', ctrl: true });
  assert.match(prompt.notice, /cut selection/);
  assert.doesNotMatch(prompt.editor.getText(), /word/);
});

test('ChatPrompt Alt+A selects all text in prompt buffer', () => {
  const prompt = new ChatPrompt({
    out: { write() {}, columns: 80, on() {}, removeListener() {} },
    input: { setRawMode() {}, resume() {}, on() {}, off() {}, pause() {} }
  });
  prompt.editor.setText('select everything in this chatbox');
  prompt.handleKey({ name: 'a', alt: true });
  assert.equal(prompt.editor.hasSelection, true);
  assert.equal(prompt.editor.getSelectedText(), 'select everything in this chatbox');
  assert.equal(prompt.notice, 'selected all input text');
});

