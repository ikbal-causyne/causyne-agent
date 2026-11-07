import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatPrompt } from '../src/tui/prompt.js';
import { LineEditor } from '../src/tui/lineEditor.js';
import { KeyDecoder } from '../src/tui/keys.js';

test('Stress test: Large multi-line unbracketed paste (1,000 lines) into ChatPrompt', () => {
  const lineCount = 1000;
  const lines: string[] = [];
  for (let i = 0; i < lineCount; i++) {
    lines.push(`> [Line ${i}] System error: https://chatgpt.com/settings/usage?ref=${i} </details>`);
  }
  const bigPayload = lines.join('\n');

  let submitted: string | null = null;
  const prompt = new ChatPrompt({ out: { write: () => {}, rows: 40, columns: 120 } });
  prompt.waiter = (val: string) => { submitted = val; };

  const start = performance.now();
  // Simulate delivering the big unbracketed payload directly on stdin
  prompt.handleData(bigPayload);
  const elapsed = performance.now() - start;

  // Assert no premature submission occurred
  assert.equal(submitted, null, 'Unbracketed paste must not submit early on embedded newlines');
  assert.equal(prompt.editor.lines.length, lineCount, `Must contain exactly ${lineCount} lines`);
  assert.equal(prompt.completion, null, 'Must bypass command/file completion on multi-line paste to avoid freezing');
  const maxPasteMs = process.env.CI ? 1500 : 200;
  assert.ok(elapsed < maxPasteMs, `Large paste processing took ${elapsed.toFixed(1)}ms (must be under ${maxPasteMs}ms)`);

  // Assert lineEditor rendering is fast
  const renderStart = performance.now();
  const layout = prompt.editor.render(100, '');
  const renderElapsed = performance.now() - renderStart;
  assert.ok(layout.rows.length >= lineCount);
  const maxRenderMs = process.env.CI ? 1200 : 150;
  assert.ok(renderElapsed < maxRenderMs, `Render took ${renderElapsed.toFixed(1)}ms (must be under ${maxRenderMs}ms)`);

  // Submitting with Enter now delivers the full payload
  prompt.handleData('\r');
  assert.equal(submitted, bigPayload, 'Full multi-line text must be submitted atomically upon pressing Enter');
});

test('Stress test: 5,000-line bracketed paste stress test', () => {
  const lineCount = 5000;
  const lines: string[] = [];
  for (let i = 0; i < lineCount; i++) {
    lines.push(`console.log("log line ${i}", { index: ${i}, active: true });`);
  }
  const codeBlock = lines.join('\n');

  let submitted: string | null = null;
  const prompt = new ChatPrompt({ out: { write: () => {}, rows: 40, columns: 120 } });
  prompt.waiter = (val: string) => { submitted = val; };

  const start = performance.now();
  prompt.handleKey({ name: 'paste', text: codeBlock, sequence: codeBlock });
  const elapsed = performance.now() - start;

  assert.equal(submitted, null);
  assert.equal(prompt.editor.lines.length, lineCount);
  assert.equal(prompt.completion, null);
  const max5kPasteMs = process.env.CI ? 2000 : 250;
  assert.ok(elapsed < max5kPasteMs, `5,000-line paste handled in ${elapsed.toFixed(1)}ms (must be under ${max5kPasteMs}ms)`);

  prompt.handleKey({ name: 'enter', sequence: '\r' });
  assert.equal(submitted, codeBlock);
});

test('Stress test: Punctuation barrage with [, ], /, @, <details>, and ANSI escapes', () => {
  const prompt = new ChatPrompt({ out: { write: () => {}, rows: 40, columns: 120 } });

  // Stream in 500 special characters in rapid sequence
  const stream = '[test_component] /model @src/index.ts </details> > error [nested [brackets]] ';
  for (let i = 0; i < 10; i++) {
    for (const char of stream) {
      prompt.handleData(char);
    }
  }

  const expectedRepeated = stream.repeat(10);
  assert.equal(prompt.editor.getText(), expectedRepeated, 'All punctuation including bare [ and ] must be preserved without viewport jumps');
  assert.equal(prompt.editor.lines.length, 1);
});

test('Stress test: Rapid-fire input bursts (2,000 key events)', () => {
  const prompt = new ChatPrompt({ out: { write: () => {}, rows: 40, columns: 120 } });

  const start = performance.now();
  for (let i = 0; i < 2000; i++) {
    if (i % 50 === 0) {
      prompt.handleData('[');
    } else if (i % 50 === 1) {
      prompt.handleData(']');
    } else if (i % 100 === 0) {
      prompt.handleKey({ name: 'backspace', sequence: '\x7f' });
    } else {
      prompt.handleData(String.fromCharCode(97 + (i % 26)));
    }
  }
  const elapsed = performance.now() - start;

  assert.ok(prompt.editor.getText().length > 1500);
  const maxBurstMs = process.env.CI ? 2000 : 300;
  assert.ok(elapsed < maxBurstMs, `2,000 rapid keystrokes processed in ${elapsed.toFixed(1)}ms (must be under ${maxBurstMs}ms)`);
});

test('Stress test: 50 consecutive paste-and-clear cycles', () => {
  const prompt = new ChatPrompt({ out: { write: () => {}, rows: 40, columns: 120 } });
  const block = Array.from({ length: 200 }, (_, i) => `item_${i}: value_${i} [tag_${i}]`).join('\n');

  const start = performance.now();
  for (let cycle = 0; cycle < 50; cycle++) {
    prompt.handleData(block);
    assert.equal(prompt.editor.lines.length, 200);
    prompt.editor.clear();
    assert.equal(prompt.editor.lines.length, 1);
    assert.equal(prompt.editor.isEmpty, true);
  }
  const elapsed = performance.now() - start;

  const maxCyclesMs = process.env.CI ? 2500 : 400;
  assert.ok(elapsed < maxCyclesMs, `50 paste-and-clear cycles completed in ${elapsed.toFixed(1)}ms (must be under ${maxCyclesMs}ms)`);
});

test('Stress test: Large single-line unbracketed paste (50,000 chars) processes in under 50ms without freeze', () => {
  const prompt = new ChatPrompt({ out: { write: () => {}, rows: 40, columns: 120 } });
  const singleLinePayload = 'https://example.com/api/v1/resource?query=' + 'abcdef1234567890'.repeat(3000); // ~48KB single line

  const start = performance.now();
  prompt.handleData(singleLinePayload);
  const elapsed = performance.now() - start;

  assert.equal(prompt.editor.lines.length, 1);
  assert.equal(prompt.editor.getText().length, singleLinePayload.length);
  const maxSingleLineMs = process.env.CI ? 500 : 50;
  assert.ok(elapsed < maxSingleLineMs, `50KB single-line paste must process in under ${maxSingleLineMs}ms without freeze, took ${elapsed.toFixed(1)}ms`);
});

test('Stress test: Terminal ANSI colored log paste strips escapes and avoids false Enter submission', () => {
  let submitted: string | null = null;
  const prompt = new ChatPrompt({ out: { write: () => {}, rows: 40, columns: 120 } });
  prompt.waiter = (val: string) => { submitted = val; };

  // Log with ANSI color escapes and newlines copied from a terminal
  const ansiLog = '\x1b[31m[ERROR]\x1b[0m Failed to compile module: \x1b[33m/app/server.ts\x1b[0m\n' +
    '\x1b[36m-->\x1b[0m src/index.ts:42:15\n' +
    '\x1b[32m✔\x1b[0m 12 tests passed, \x1b[31m✖\x1b[0m 1 failed\n';

  prompt.handleData(ansiLog);

  // Must not submit early on the embedded newlines
  assert.equal(submitted, null, 'ANSI log paste must not trigger premature submission on embedded newlines');
  assert.equal(prompt.editor.lines.length, 4, 'Must contain 4 lines without ANSI corruption');

  const text = prompt.editor.getText();
  assert.ok(!text.includes('\x1b['), 'ANSI escape sequences must be stripped from pasted input');
  assert.ok(text.includes('[ERROR] Failed to compile module: /app/server.ts'));
});


