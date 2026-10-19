// The approval prompt's diff, the live status line, and link safety.
//
// These three exist for one reason each:
//
//  * diff.js — the approval gate used to ask a human to authorise a file
//    mutation whose content they had never seen. A gate you cannot see through
//    is a formality. The bounds matter as much as the diff: the input is
//    model-supplied, and an unbounded one hangs the terminal at exactly the
//    moment consent is being asked for.
//  * statusLine.js — a forty-step run showed "Thinking…" and nothing else.
//  * theme.safeLink — OSC 8 is an escape sequence. Emitting one on behalf of a
//    URL that came from a model reply is the injection sanitize() exists to
//    prevent, so the URL has to survive a parse-and-rebuild round trip first.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { diffLines, diffStat, renderDiff, approvalDiff, MAX_SIDE_LINES } from '../src/tui/diff.js';
import { StatusLine, compactCount, formatCost, formatElapsed } from '../src/tui/statusLine.js';
import { safeLink, HAS_HYPERLINKS } from '../src/tui/theme.js';
import { stripAnsi, visibleWidth } from '../src/tui/text.js';

describe('line diff', () => {
  test('a replaced line shows as one removal and one addition', () => {
    const { ops } = diffLines('a\nb\nc', 'a\nB\nc');
    const stat = diffStat(ops);
    assert.equal(stat.added, 1);
    assert.equal(stat.removed, 1);
  });

  test('identical text produces no changes', () => {
    const { ops } = diffLines('same\ntext', 'same\ntext');
    assert.deepEqual(diffStat(ops), { added: 0, removed: 0 });
  });

  test('a trailing newline is not a phantom changed line', () => {
    // Splitting naively on \n gives ['a',''] and reports a change that the user
    // cannot see, which is how a diff loses its credibility.
    const { ops } = diffLines('a\n', 'a');
    assert.deepEqual(diffStat(ops), { added: 0, removed: 0 });
  });

  test('CRLF and LF are not treated as a whole-file rewrite', () => {
    const { ops } = diffLines('a\r\nb\r\n', 'a\nb\n');
    assert.deepEqual(diffStat(ops), { added: 0, removed: 0 });
  });

  test('creation from empty is all additions', () => {
    const { ops } = diffLines('', 'one\ntwo');
    assert.deepEqual(diffStat(ops), { added: 2, removed: 0 });
  });

  test('an oversized side is bounded rather than diffed whole', () => {
    const huge = Array.from({ length: MAX_SIDE_LINES + 500 }, (_, i) => `line ${i}`).join('\n');
    const started = Date.now();
    const { truncated } = diffLines(huge, huge + '\nextra');
    assert.equal(truncated, true, 'the bound must be reported, not hidden');
    assert.ok(Date.now() - started < 5000, 'the LCS must stay bounded on hostile input');
  });
});

describe('diff rendering', () => {
  test('unchanged runs collapse instead of printing the whole file', () => {
    const before = Array.from({ length: 200 }, (_, i) => `line ${i}`).join('\n');
    const after = before.replace('line 150', 'line CHANGED');
    const { rows } = renderDiff(before, after, { width: 80 });
    assert.ok(rows.length < 20, `expected a collapsed diff, got ${rows.length} rows`);
    assert.ok(rows.some((row) => /unchanged line/.test(stripAnsi(row))), 'the skipped rows must be accounted for');
  });

  test('rendering is capped so the approval question stays on screen', () => {
    const before = Array.from({ length: 400 }, (_, i) => `old ${i}`).join('\n');
    const after = Array.from({ length: 400 }, (_, i) => `new ${i}`).join('\n');
    const { rows, clipped } = renderDiff(before, after, { width: 80, maxLines: 12 });
    assert.ok(rows.length <= 12);
    assert.equal(clipped, true);
  });

  test('no row exceeds the terminal width', () => {
    const after = 'x'.repeat(500);
    const { rows } = renderDiff('', after, { width: 60 });
    for (const row of rows) assert.ok(visibleWidth(row) <= 60, `row of ${visibleWidth(row)} columns overflows`);
  });

  test('escapes inside file content cannot reach the terminal', () => {
    // A file that repaints the screen one row above an approval prompt can
    // rewrite the question the user is answering.
    const hostile = 'harmless\n\x1b[2J\x1b[1;1Hyou approved this\n';
    const { rows } = renderDiff('harmless\n', hostile, { width: 80 });
    const printed = rows.join('\n');
    assert.ok(!printed.includes('\x1b[2J'), 'a screen-clear escape survived into the diff');
    assert.ok(!printed.includes('\x1b[1;1H'), 'a cursor-home escape survived into the diff');
  });

  test('a credential inside an edit is masked', () => {
    const fakeKey = `sk-${'a'.repeat(20)}`;
    const { rows } = renderDiff('', `API_KEY=${fakeKey}\n`, { width: 80 });
    const printed = stripAnsi(rows.join('\n'));
    assert.ok(!printed.includes(fakeKey), 'the diff printed a credential in full');
  });

  test('markers carry the meaning without colour', () => {
    const { rows } = renderDiff('a', 'b', { width: 40 });
    const plain = rows.map(stripAnsi);
    assert.ok(plain.some((row) => row.trim().startsWith('-')));
    assert.ok(plain.some((row) => row.trim().startsWith('+')));
  });
});

describe('approval diff for the file-mutating tools', () => {
  test('an edit list is diffed from its search and replace sides', () => {
    const diff = approvalDiff('fs_edit', {
      path: '/tmp/example.js',
      edits: [{ searchContent: 'const a = 1;', replaceContent: 'const a = 2;' }]
    }, { width: 80 });
    assert.ok(diff, 'an edit must produce a diff');
    assert.equal(diff.added, 1);
    assert.equal(diff.removed, 1);
  });

  test('MultiEdit uses its own argument names', () => {
    const diff = approvalDiff('MultiEdit', {
      file_path: '/tmp/example.js',
      edits: [{ old_string: 'foo', new_string: 'bar' }]
    }, { width: 80 });
    assert.ok(diff);
    assert.equal(diff.added, 1);
  });

  test('writing a new file is labelled as a creation', () => {
    const target = path.join(os.tmpdir(), `causyne-diff-${process.pid}-absent.txt`);
    try { fs.unlinkSync(target); } catch (e) { /* already absent */ }
    const diff = approvalDiff('fs_write', { path: target, content: 'hello\n' }, { width: 80 });
    assert.ok(diff);
    assert.equal(diff.note, 'new file');
    assert.equal(diff.removed, 0);
  });

  test('overwriting an existing file diffs against what is on disk', () => {
    const target = path.join(os.tmpdir(), `causyne-diff-${process.pid}-existing.txt`);
    fs.writeFileSync(target, 'one\ntwo\nthree\n', 'utf8');
    try {
      const diff = approvalDiff('fs_write', { path: target, content: 'one\nTWO\nthree\n' }, { width: 80 });
      assert.ok(diff, 'an overwrite must show what it replaces');
      assert.equal(diff.added, 1);
      assert.equal(diff.removed, 1);
    } finally {
      fs.unlinkSync(target);
    }
  });

  test('a no-op write produces no diff rather than an empty box', () => {
    const target = path.join(os.tmpdir(), `causyne-diff-${process.pid}-noop.txt`);
    fs.writeFileSync(target, 'same\n', 'utf8');
    try {
      assert.equal(approvalDiff('fs_write', { path: target, content: 'same\n' }, { width: 80 }), null);
    } finally {
      fs.unlinkSync(target);
    }
  });

  test('a tool that does not touch files has no diff', () => {
    assert.equal(approvalDiff('sysRun', { command: 'ls -la' }, { width: 80 }), null);
    assert.equal(approvalDiff('webSearch', { query: 'x' }, { width: 80 }), null);
  });

  test('a model-supplied tool name cannot reach Object.prototype', () => {
    // TOOL_DISPLAY was an object literal once, and 'constructor' resolved up the
    // prototype chain to a function that was then called as a display helper.
    assert.equal(approvalDiff('constructor', {}, { width: 80 }), null);
    assert.equal(approvalDiff('__proto__', {}, { width: 80 }), null);
    assert.equal(approvalDiff('toString', {}, { width: 80 }), null);
  });

  test('malformed arguments never throw', () => {
    assert.doesNotThrow(() => approvalDiff('fs_edit', null, { width: 80 }));
    assert.doesNotThrow(() => approvalDiff('fs_edit', { edits: 'not an array' }, { width: 80 }));
    assert.doesNotThrow(() => approvalDiff('fs_write', { path: 42, content: {} }, { width: 80 }));
    assert.doesNotThrow(() => approvalDiff(undefined, undefined, {}));
  });

  test('a directory given as a path does not break the prompt', () => {
    assert.doesNotThrow(() => approvalDiff('fs_write', { path: os.tmpdir(), content: 'x' }, { width: 80 }));
  });
});

describe('status line', () => {
  test('counts and money are formatted to be read at a glance', () => {
    assert.equal(compactCount(940), '940');
    assert.equal(compactCount(12480), '12k');
    assert.equal(compactCount(1250000), '1.3M');
    // A sub-cent run printed as $0.00 reads as free.
    assert.equal(formatCost(0.0041), '$0.0041');
    assert.equal(formatCost(0.412), '$0.412');
    assert.equal(formatCost(12.5), '$12.50');
    assert.equal(formatElapsed(1500), '1.5s');
    assert.equal(formatElapsed(74300), '1m14s');
  });

  test('the line never exceeds the width it was given', () => {
    const status = new StatusLine().setSession({ model: 'anthropic/claude-opus-5', relayEnabled: true });
    status.onUsage({ usedTokens: 128000, taskCostUsd: 4.21, cachedTokens: 90000 });
    for (const width of [120, 100, 80, 60, 40, 24, 12]) {
      const line = status.render({ message: 'reading project files', elapsedMs: 74300, steps: 12, width, spinnerFrame: '*' });
      assert.ok(visibleWidth(line) <= width, `width ${width} produced ${visibleWidth(line)} columns`);
    }
  });

  test('segments are dropped whole, never truncated into a half-number', () => {
    const status = new StatusLine().setSession({ model: 'claude-opus-5' });
    status.onUsage({ usedTokens: 12480, taskCostUsd: 0.0412 });
    const narrow = stripAnsi(status.render({ message: 'working', elapsedMs: 74300, steps: 7, width: 34, spinnerFrame: '*' }));
    assert.ok(!/\$0\.04…|12k to…/.test(narrow), 'a truncated number is worse than a missing one');
  });

  test('the message keeps its natural width on a wide terminal', () => {
    const status = new StatusLine().setSession({ model: 'claude-opus-5', relayEnabled: true });
    status.onUsage({ usedTokens: 12480, taskCostUsd: 0.0412, cachedTokens: 8000 });
    const wide = stripAnsi(status.render({ message: 'reading project files', elapsedMs: 74300, steps: 7, width: 120, spinnerFrame: '*' }));
    assert.ok(wide.includes('reading project files'), 'the message lost to the counters on a wide line');
  });

  test('a task total replaces the running sum instead of doubling it', () => {
    const status = new StatusLine();
    status.onUsage({ costUsd: 0.01, taskCostUsd: 0.01 });
    status.onUsage({ costUsd: 0.01, taskCostUsd: 0.02 });
    assert.equal(status.turnCost, 0.02, 'the task total already includes every response');
  });

  test('reset clears the per-turn counters but keeps the session facts', () => {
    const status = new StatusLine().setSession({ model: 'claude-opus-5' });
    status.onUsage({ usedTokens: 500, taskCostUsd: 0.5 });
    status.reset();
    assert.equal(status.turnTokens, 0);
    assert.equal(status.turnCost, 0);
    assert.equal(status.model, 'claude-opus-5');
  });

  test('an escape in the status message is stripped', () => {
    const status = new StatusLine();
    const line = status.render({ message: 'busy\x1b[2Jwiped', width: 60 });
    assert.ok(!line.includes('\x1b[2J'));
  });
});

describe('link safety', () => {
  test('only plain http and https are ever emitted', () => {
    for (const hostile of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,<script>',
      'vbscript:x',
      'https://ok.dev/\x1b]8;;http://evil.dev\x1b\\',
      'https://ok.dev/\x07',
      'not a url',
      ''
    ]) {
      assert.equal(safeLink('LABEL', hostile), 'LABEL', `${JSON.stringify(hostile)} produced a link`);
    }
  });

  test('an over-long url is refused rather than emitted', () => {
    assert.equal(safeLink('LABEL', 'https://ok.dev/' + 'a'.repeat(3000)), 'LABEL');
  });

  test('a legitimate url round-trips when the terminal supports it', (t) => {
    if (!HAS_HYPERLINKS) return t.skip('terminal does not advertise OSC 8 support');
    const rendered = safeLink('LABEL', 'https://ok.dev/guide');
    assert.ok(rendered.includes('\x1b]8;;https://ok.dev/guide'));
    assert.ok(rendered.endsWith('\x1b]8;;\x1b\\'));
  });
});
