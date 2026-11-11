import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { StageSurface, createStageSurface } from '../src/tui/stageSurface.js';
import { ChatPrompt } from '../src/tui/prompt.js';
import { PromptHistory } from '../src/tui/history.js';

function terminal() {
  const writes = [];
  const out = {
    columns: 100, rows: 35, isTTY: true,
    write(value) { writes.push(String(value)); return true; },
    on() {}, removeListener() {}
  };
  return { out, writes };
}

test('Home never re-arms mouse mode behind the teardown state machine', () => {
  const { out, writes } = terminal();
  const surface = new StageSurface({ out, env: { TERM: 'xterm', CAUSYNE_MOUSE: '1', CAUSYNE_MOUSE_HOVER: '1' } });
  surface.enterHome({ cwd: process.cwd(), provider: 'test' });
  assert.equal(surface.open(), true);
  assert.equal(surface.mouseOn, false);
  assert.equal(surface.captureMouse(), false);
  assert.equal(surface.mouseCaptured, false);
  surface.close();
  const text = writes.join('');
  assert.equal(text.includes('\x1b[?1000h'), false, 'Home must never activate tracking');
  assert.ok(text.includes('\x1b[?1000l'), 'exit must disarm mouse tracking even when state says it is off');
  assert.ok(text.includes('\x1b[?1003l'), 'exit must disarm any lingering motion tracking');
});

test('normal session can release/re-capture mouse and always disables it on exit', () => {
  const { out, writes } = terminal();
  const surface = createStageSurface({ out, env: { TERM: 'xterm', CAUSYNE_MOUSE: '1' } });
  assert.ok(surface);
  assert.equal(surface.mouseCaptured, true);
  assert.equal(writes.join('').includes('\x1b[?1003h'), false,
    'terminal-wide motion capture must not be silently enabled');
  assert.equal(surface.releaseMouse(), true);
  assert.equal(surface.captureMouse(), true);
  assert.equal(surface.close(), true);
  assert.equal(surface.mouseOn, false);
  assert.equal(surface.mouseCaptured, false);
  const outBytes = writes.join('');
  assert.ok(outBytes.lastIndexOf('\x1b[?1006l') > outBytes.lastIndexOf('\x1b[?1006h'));
  assert.ok(outBytes.lastIndexOf('\x1b[?1000l') > outBytes.lastIndexOf('\x1b[?1000h'));
});

test('disabled mouse tracking cannot be rearmed by keyboard or wheel fallback', () => {
  const { out, writes } = terminal();
  const surface = new StageSurface({ out, env: { TERM: 'xterm', CAUSYNE_MOUSE: '0' } });
  assert.equal(surface.open(), true);
  assert.equal(surface.captureMouse(), false);
  assert.equal(surface.mouseCaptured, false);
  surface.close();
  assert.equal(writes.join('').includes('\x1b[?1000h'), false);
  assert.ok(writes.join('').includes('\x1b[?1000l'));
});

test('prompt restores raw input and bracketed paste on process exit and unregisters hook on stop', () => {
  const { out, writes } = terminal();
  const input = new EventEmitter();
  const rawModes = [];
  input.setRawMode = (value) => { rawModes.push(value); };
  input.resume = () => {};
  input.pause = () => {};
  const historyFile = path.join(os.tmpdir(), `causyne-raw-exit-${process.pid}-${Date.now()}.json`);
  const prompt = new ChatPrompt({ input, out, history: new PromptHistory({ file: historyFile }) });
  const initialListeners = process.listenerCount('exit');
  try {
    prompt.start();
    assert.equal(process.listenerCount('exit'), initialListeners + 1);
    assert.equal(rawModes.at(-1), true);
    prompt.exitHook();
    assert.equal(rawModes.at(-1), false);
    assert.ok(writes.join('').includes('\x1b[?2004l'));
    prompt.stop();
    assert.equal(process.listenerCount('exit'), initialListeners);
    assert.equal(rawModes.at(-1), false);
  } finally {
    if (prompt.active) prompt.stop();
    try { fs.unlinkSync(historyFile); } catch {}
  }
});
