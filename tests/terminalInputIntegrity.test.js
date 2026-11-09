import test from 'node:test';
import assert from 'node:assert/strict';

import { TerminalInputFramer, shouldTreatAsAtomicPaste } from '../src/tui/terminalInputFramer.js';
import { KeyDecoder, PASTE_START, PASTE_END } from '../src/tui/keys.js';
import { ChatPrompt } from '../src/tui/prompt.js';
import { normalizeClipboardText } from '../src/tui/chatboxClipboard.js';

function prompt() {
  const chunks = [];
  const view = new ChatPrompt({ out: {
    columns: 100, rows: 30, write(text) { chunks.push(text); return true; },
    on() {}, removeListener() {}
  }});
  return { view, chunks };
}

function decoderEvents(chunks) {
  const framer = new TerminalInputFramer();
  const decoder = new KeyDecoder();
  const events = [];
  for (const chunk of chunks) {
    for (const frame of framer.push(chunk)) {
      events.push(...decoder.decode(frame));
    }
  }
  for (const frame of framer.flush()) {
    events.push(...decoder.decode(frame));
  }
  return events;
}

test('framer holds trailing ESC and trailing orphan [ without losing adjacent typing', () => {
  const framer = new TerminalInputFramer();
  assert.deepEqual(framer.push(Buffer.from('a\x1b')), [Buffer.from('a')]);
  assert.deepEqual(framer.push(Buffer.from('[<65;28;41M')).map(x => x.toString()), ['\x1b[<65;28;41M']);
  assert.equal(framer.hasPending, false);
  assert.deepEqual(framer.push('['), []);
  assert.deepEqual(framer.flush().map(x => x.toString()), ['[']);
});

test('framer does not split a real ESC [ at the end of the input chunk', () => {
  const framer = new TerminalInputFramer();
  assert.deepEqual(framer.push('abc\x1b[').map(x => x.toString()), ['abc']);
  assert.deepEqual(framer.push('<64;19;11M').map(x => x.toString()), ['\x1b[<64;19;11M']);
});

test('atomic paste never bypasses decoder with pending mouse, CSI or bracketed paste', () => {
  const decoder = new KeyDecoder();
  assert.equal(shouldTreatAsAtomicPaste('a'.repeat(100), decoder), true);
  assert.equal(shouldTreatAsAtomicPaste('a\nb', decoder), true);
  assert.equal(shouldTreatAsAtomicPaste('\x1b[31mhello\x1b[0m\nworld', decoder), true);
  assert.equal(shouldTreatAsAtomicPaste('\x1b[<65;10;20M'+'a'.repeat(70), decoder), false);
  assert.equal(shouldTreatAsAtomicPaste('a'.repeat(70)+'[<65;10;20M', decoder), false);
  assert.equal(shouldTreatAsAtomicPaste('a'.repeat(70)+'\x1b[200~', decoder), false);
  decoder.pending = Buffer.from('\x1b[<65;10');
  assert.equal(shouldTreatAsAtomicPaste('20M'+'x'.repeat(200), decoder), false);
  decoder.pending = Buffer.alloc(0);
  decoder.inPaste = true;
  assert.equal(shouldTreatAsAtomicPaste('a'.repeat(100), decoder), false);
});

test('bracketed paste reassembles UTF-8 split inside supplementary-plane emoji', () => {
  const payload = '你好\n🚀\nRésumé';
  const bytes = Buffer.from(`${PASTE_START}${payload}${PASTE_END}`);
  const events = decoderEvents([...bytes].map(byte => Buffer.from([byte])));
  assert.deepEqual(events.map(x => x.name), ['paste']);
  assert.equal(events[0].text, payload);
  assert.equal(events[0].text.includes('\uFFFD'), false);
});

test('partial paste terminator stays out of paste text even when split into six chunks', () => {
  const decoder = new KeyDecoder();
  const inputs = ['\x1b[200~', 'ab🚀', '\x1b', '[', '2', '0', '1', '~'];
  const events = inputs.flatMap(part => decoder.decode(part));
  assert.equal(events.length, 1);
  assert.equal(events[0].text, 'ab🚀');
});

test('oversized bracketed paste is rejected atomically, preserving user draft', () => {
  const { view } = prompt();
  view.editor.setText('keep this draft');
  view.handleData(Buffer.from(`${PASTE_START}${'x'.repeat(2 * 1024 * 1024 + 20)}${PASTE_END}`));
  assert.equal(view.editor.getText(), 'keep this draft');
  assert.match(view.notice, /2 MiB/i);
});

test('split SGR mouse report is swallowed even when starting with a lone ESC chunk', () => {
  const { view } = prompt();
  view.handleData(Buffer.from('\x1b'));
  view.handleData(Buffer.from('[<65;110;52M'));
  assert.equal(view.editor.getText(), '');
  assert.equal(view.decoder.pending.length, 0);
});

test('mouse report after normal characters must not become clipboard-paste text', () => {
  const { view } = prompt();
  view.handleData(Buffer.from('correct words \x1b'));
  view.handleData(Buffer.from('[<35;83;55M'));
  assert.equal(view.editor.getText(), 'correct words ');
});

test('orphan mouse report split after [ does not corrupt draft', () => {
  const { view } = prompt();
  view.handleData('[');
  view.handleData('<65;110;52M');
  assert.equal(view.editor.getText(), '');
});

test('ordinary code with [<... remains typable, even when chunks split', () => {
  const decoder = new KeyDecoder();
  const chars = decoderEvents(['[<', 'div>']);
  assert.equal(chars.filter(key => key.name === 'char').map(key => key.text).join(''), '[<div>');
});

test('copy-paste normalization strips full terminal CSI/OSC formatting without leaving control tails', () => {
  const input = '\x1b[31mERROR\x1b[0m\r\nhello\x1b]0;malicious title\x07\tworld';
  assert.equal(normalizeClipboardText(input), 'ERROR\nhello\tworld');
});

test('queue limit preserves the draft instead of discarding the thirty-third queued message', () => {
  const { view } = prompt();
  view.setBusy(true);
  view.queue = Array.from({length: 32}, (_, i) => `queued ${i}`);
  view.editor.setText('work in progress');
  view.submit();
  assert.equal(view.editor.getText(), 'work in progress');
  assert.equal(view.queue.length, 32);
  assert.match(view.notice, /32 queued/);
});


test('unbracketed long UTF-8 input split during emoji remains byte-exact', () => {
  const { view } = prompt();
  const original = 'x'.repeat(70) + '🚀';
  const raw = Buffer.from(original, 'utf8');
  view.handleData(raw.subarray(0, -2));
  view.handleData(raw.subarray(-2));
  assert.equal(view.editor.getText(), original);
  assert.doesNotMatch(view.editor.getText(), /\uFFFD/);
});
