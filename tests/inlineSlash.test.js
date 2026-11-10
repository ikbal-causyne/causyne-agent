import test from 'node:test';
import assert from 'node:assert/strict';

import {
  detectInlineSlashTrigger,
  removeInlineSlashToken,
  isInlineSkillInvocation
} from '../src/tui/inlineSlash.js';
import { detectTrigger, suggest, applyCompletion } from '../src/tui/completion.js';
import { ChatPrompt } from '../src/tui/prompt.js';
import { parseCommand } from '../src/commands.js';

function makePrompt() {
  const output = {
    isTTY: true, columns: 100, rows: 30,
    write() { return true; }, on() {}, removeListener() {}
  };
  const input = {
    isTTY: true, on() {}, off() {}, resume() {}, pause() {}, setRawMode() {}
  };
  return new ChatPrompt({ out: output, input });
}

function select(prompt, value) {
  const index = prompt.completion?.items.findIndex((item) => item.value === value);
  assert.ok(index >= 0, `Expected completion ${value}`);
  prompt.selected = index;
}

test('slash menu is active after existing prose but not inside URLs or paths', () => {
  for (const text of ['Please inspect /', 'Fix this /mo', 'First line\n/model']) {
    const trigger = detectTrigger(text, text.length);
    assert.equal(trigger?.kind, 'command');
    assert.equal(trigger?.inline, true);
  }
  for (const text of ['https://example.com', 'read /usr/local/bin', 'A/B', 'foo/bar', 'path/to/file']) {
    assert.equal(detectInlineSlashTrigger(text, text.length), null, text);
  }
  assert.equal(detectTrigger('/mo', 3)?.inline, false);
  assert.equal(parseCommand('Please inspect /model'), null,
    'ordinary message submission must not accidentally execute inline commands');
});

test('inline command arguments and caret offsets are correct', () => {
  const text = 'Review this /skills dev';
  const trigger = detectTrigger(text, text.length);
  assert.equal(trigger?.kind, 'command-argument');
  assert.equal(trigger?.command, 'skills');
  assert.equal(trigger?.query, 'dev');
  assert.equal(trigger?.tokenStart, text.indexOf('/skills'));
  assert.equal(trigger?.inline, true);
});

test('inline slash menu returns real command registry entries', () => {
  const text = 'Already written prose /mo';
  const menu = suggest(text, text.length);
  assert.equal(menu?.kind, 'command');
  assert.ok(menu.items.some((item) => item.value === '/model'));
});

test('removal is bounded to slash token and preserves text on both sides', () => {
  const text = 'Before /model After';
  const cursor = text.indexOf('/model') + 3; // caret in the middle of command
  const trigger = detectTrigger(text, cursor);
  const result = removeInlineSlashToken(text, cursor, trigger);
  assert.deepEqual(result, { text: 'Before  After', cursor: text.indexOf('/model') });
});

test('UTF-16 offsets and multiline drafts survive inline token removal', () => {
  const text = '🧪 Build project\nReview /hel';
  const trigger = detectTrigger(text, text.length);
  const removed = removeInlineSlashToken(text, text.length, trigger);
  assert.equal(removed.text, '🧪 Build project\nReview ');
  assert.equal(removed.cursor, '🧪 Build project\nReview '.length);
});

test('only valid compiled-skill invocations consume draft instructions', () => {
  assert.equal(isInlineSkillInvocation('/skills devops/docker-multi-stage-builds'), true);
  assert.equal(isInlineSkillInvocation('/skills devops'), false);
  assert.equal(isInlineSkillInvocation('/skill rm devops/docker'), false);
  assert.equal(isInlineSkillInvocation('/model'), false);
});

test('Enter executes selected inline command and preserves unsent message', () => {
  const prompt = makePrompt();
  const sent = [];
  prompt.waiter = (message) => sent.push(message);
  prompt.editor.setText('Write a release plan /mo');
  prompt.refreshCompletion();
  select(prompt, '/model');
  prompt.handleKey({ name: 'enter' });
  assert.deepEqual(sent, ['/model']);
  assert.equal(prompt.editor.getText(), 'Write a release plan ');
  assert.equal(prompt.completion, null);
});

test('Mouse selection routes through same inline command logic', () => {
  const prompt = makePrompt();
  let sent = null;
  prompt.waiter = (message) => { sent = message; };
  prompt.editor.setText('Please change the model /mo');
  prompt.refreshCompletion();
  select(prompt, '/model');
  prompt.handleCompletionKey({ name: 'mouse', mouse: { pressed: true, button: 0 } });
  assert.equal(sent, '/model');
  assert.equal(prompt.editor.getText(), 'Please change the model ');
});

test('Tab never triggers an in-draft command', () => {
  const prompt = makePrompt();
  let sent = null;
  prompt.waiter = (message) => { sent = message; };
  prompt.editor.setText('Draft /mo');
  prompt.refreshCompletion();
  select(prompt, '/model');
  prompt.handleKey({ name: 'tab' });
  assert.equal(sent, null);
  assert.equal(prompt.editor.getText(), 'Draft /mo');
  assert.match(prompt.notice, /Enter/);
});

test('Escape and Shift+Enter never execute an inline command', () => {
  const prompt = makePrompt();
  const text = 'Review /mo';
  prompt.editor.setText(text);
  prompt.refreshCompletion();
  prompt.handleKey({ name: 'escape' });
  assert.equal(prompt.editor.getText(), text);
  prompt.refreshCompletion();
  prompt.handleKey({ name: 'enter', shift: true });
  assert.equal(prompt.editor.getText(), text + '\n');
});

test('Escape preserves a longer draft even when it begins with a slash', () => {
  const prompt = makePrompt();
  const draft = '/skills devops help me /mo';
  prompt.editor.setText(draft);
  prompt.refreshCompletion();
  assert.equal(prompt.completion?.inline, true);
  prompt.handleKey({ name: 'escape' });
  assert.equal(prompt.editor.getText(), draft);
});

test('Selecting a compiled skill runs it against the draft as its instruction', () => {
  const prompt = makePrompt();
  let submitted = null;
  prompt.waiter = (message) => { submitted = message; };
  prompt.editor.setText('Create a Dockerfile /docker');
  prompt.refreshCompletion();
  const value = '/skills devops/docker-multi-stage-builds';
  select(prompt, value);
  prompt.handleKey({ name: 'enter' });
  assert.equal(submitted, `${value} Create a Dockerfile`);
  assert.equal(prompt.editor.getText(), '');
});

test('Full queue refuses inline command without deleting the draft', () => {
  const prompt = makePrompt();
  prompt.busy = true;
  prompt.queue = Array.from({ length: 32 }, (_, i) => `task ${i}`);
  prompt.editor.setText('Preserve me /mo');
  prompt.refreshCompletion();
  select(prompt, '/model');
  prompt.handleKey({ name: 'enter' });
  assert.equal(prompt.editor.getText(), 'Preserve me /mo');
  assert.equal(prompt.queue.length, 32);
  assert.match(prompt.notice, /32 queued/);
});

test('Non-inline command selection retains the current one-enter behavior', () => {
  const prompt = makePrompt();
  let submitted = null;
  prompt.waiter = (message) => { submitted = message; };
  prompt.editor.setText('/mo');
  prompt.refreshCompletion();
  select(prompt, '/model');
  prompt.handleKey({ name: 'enter' });
  assert.equal(submitted, '/model');
  assert.equal(prompt.editor.getText(), '');
});

test('Regular command completion and @ mentions remain available', () => {
  assert.equal(suggest('/mo', 3)?.kind, 'command');
  assert.equal(detectTrigger('fix @README', 'fix @README'.length)?.kind, 'file');
  const leading = suggest('/mo', 3);
  assert.equal(applyCompletion('/mo', 3, leading, { value: '/model' }).text, '/model ');
});
