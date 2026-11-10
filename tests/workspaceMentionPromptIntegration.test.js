import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChatPrompt } from '../src/tui/prompt.js';

test('an already typed @ filename becomes selectable when the async workspace scan completes', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-prompt-index-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'HOLD', 'chatbox-tui'), { recursive: true });
  fs.writeFileSync(path.join(root, 'HOLD', 'chatbox-tui', 'CausyneChatbox_FULL_SOURCE.md'), '# source');
  const input = { isTTY: true, setRawMode() {}, resume() {}, pause() {}, on() {}, off() {} };
  const out = { isTTY: true, columns: 100, rows: 30, write() { return true; }, on() {}, off() {} };
  const prompt = new ChatPrompt({ root, input, out });
  prompt.active = true;
  prompt.editor.setText('apply @CausyneChat');
  let rerenders = 0;
  prompt.scheduleDraw = () => { rerenders++; };
  await prompt.index.ensure(true);
  assert.ok(rerenders > 0, 'index completion must trigger an on-screen update');
  assert.ok(prompt.completion?.items.some(item =>
    item.value === 'HOLD/chatbox-tui/CausyneChatbox_FULL_SOURCE.md'));
  prompt.index.dispose();
});

test('changing workspace clears old @ results and rebinds index', async t => {
  const rootA = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-root-a-'));
  const rootB = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-root-b-'));
  t.after(() => { fs.rmSync(rootA, { recursive: true, force: true }); fs.rmSync(rootB, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(rootA, 'alphaOnly.ts'), '');
  fs.writeFileSync(path.join(rootB, 'betaOnly.ts'), '');
  const input = { isTTY: true, setRawMode() {}, resume() {}, pause() {}, on() {}, off() {} };
  const out = { isTTY: true, columns: 100, rows: 30, write() { return true; }, on() {}, off() {} };
  const prompt = new ChatPrompt({ root: rootA, input, out });
  prompt.active = true;
  prompt.editor.setText('@alphaOnly');
  prompt.scheduleDraw = () => {};
  await prompt.index.ensure(true);
  assert.ok(prompt.completion?.items.some(item => item.value === 'alphaOnly.ts'));
  prompt.setWorkingRoot(rootB);
  prompt.editor.setText('@betaOnly');
  await prompt.index.ensure(true);
  assert.ok(prompt.completion?.items.some(item => item.value === 'betaOnly.ts'));
  assert.ok(!prompt.completion?.items.some(item => item.value === 'alphaOnly.ts'));
  prompt.index.dispose();
});
