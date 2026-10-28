import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ToolOutputStore, processToolOutputWithStore } from '../src/tools/toolOutputStore.js';

test('ToolOutputStore: short output is returned verbatim without disk spill', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-store-test-'));
  try {
    const store = new ToolOutputStore({ storageDir: tmpDir });
    const output = 'Short clean output\nAll good.';
    const result = store.processToolOutput('session_1', 'call_1', output);

    assert.equal(result.isTruncated, false);
    assert.equal(result.contentForModel, output);
    assert.equal(result.totalLines, 2);
    assert.equal(result.diskPath, undefined);
    assert.equal(typeof result.contentHash, 'string');
    assert.equal(result.contentHash.length, 12);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ToolOutputStore: oversized output is truncated with head and tail preserved on disk', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-store-test-'));
  try {
    const store = new ToolOutputStore({
      storageDir: tmpDir,
      maxLines: 20,
      headLines: 5,
      tailLines: 5,
      maxChars: 1500
    });

    const lines: string[] = [];
    for (let i = 1; i <= 100; i++) {
      lines.push(`Line ${i}: log message with detail ${i * 42}`);
    }
    const rawOutput = lines.join('\n');

    const result = store.processToolOutput('session_big', 'call_build', rawOutput);

    assert.equal(result.isTruncated, true);
    assert.equal(result.totalLines, 100);
    assert.ok(result.diskPath && fs.existsSync(result.diskPath), 'diskPath must exist on disk');

    // Model content should start with head lines and end with tail lines
    assert.match(result.contentForModel, /^Line 1: log message/);
    assert.match(result.contentForModel, /Line 5: log message/);
    assert.match(result.contentForModel, /Line 100: log message/);
    assert.match(result.contentForModel, /Causyne ToolOutputStore: 90 lines/);
    assert.match(result.contentForModel, /Content Hash: [0-9a-f]{12}/);

    // Test readSlice
    const slice = store.readSlice(result.diskPath, 10, 12);
    const expected = ['Line 10: log message with detail 420', 'Line 11: log message with detail 462', 'Line 12: log message with detail 504'].join('\n');
    assert.equal(slice, expected);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('ToolOutputStore: standalone helper uses default store', () => {
  const result = processToolOutputWithStore('s_temp', 'call_help', 'Hello world');
  assert.equal(result.isTruncated, false);
  assert.equal(result.contentForModel, 'Hello world');
});

test('a single minified line has a bounded preview and exact recoverable bytes', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-minified-'));
  try {
    const store = new ToolOutputStore({ storageDir: directory });
    const text = 'START' + 'x'.repeat(200_000) + 'END';
    const stored = store.processToolOutput('session', 'call', text);
    assert.ok(stored.contentForModel.length <= 2500);
    assert.match(stored.contentForModel, /^START/);
    assert.match(stored.contentForModel, /END$/);
    assert.equal(fs.readFileSync(stored.diskPath!, 'utf8'), text);
    assert.throws(() => store.readSlice(path.join(directory, '..', 'outside'), 1, 2));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
