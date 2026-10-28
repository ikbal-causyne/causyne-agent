import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-history-prune-'));
const previousHome = process.env.CAUSYNE_HOME;
process.env.CAUSYNE_HOME = root;
const { buildRecoverableDroppedSummary, pruneStaleToolObservations, shortenOversizedToolObservations,
  pruneExecutedToolArguments } = await import('../src/historyPruner.ts');

after(() => {
  if (previousHome === undefined) delete process.env.CAUSYNE_HOME;
  else process.env.CAUSYNE_HOME = previousHome;
  fs.rmSync(root, { recursive: true, force: true });
});

test('40-step history keeps four recent observations and makes older output recoverable', () => {
  const messages = Array.from({ length: 40 }, (_, index) => ({
    role: 'tool',
    name: 'fs_read',
    tool_call_id: `call-${index}`,
    content: JSON.stringify({ success: true, output: `step-${index} ${'x'.repeat(3000)}` })
  }));
  const originals = messages.map(message => message.content);
  const before = originals.reduce((sum, item) => sum + item.length, 0);
  const result = pruneStaleToolObservations(messages, { taskId: 'forty', keepRecent: 4 });
  const afterChars = messages.reduce((sum, item) => sum + item.content.length, 0);

  assert.equal(result.pruned, 36);
  assert.equal(result.spillFailures, 0);
  assert.ok(afterChars < before * 0.2, `expected meaningful context saving: ${afterChars}/${before}`);
  assert.deepEqual(messages.slice(-4).map(message => message.content), originals.slice(-4));
  assert.equal(messages[0]?.tool_call_id, 'call-0');
  const pointer = messages[0]?.content.match(/at (.+?) — read or search/);
  assert.ok(pointer, 'decayed output must name a recovery file');
  assert.equal(fs.readFileSync(pointer[1], 'utf8'), originals[0]);
});

test('no outcome is invented when a tool result lacks an explicit verdict', () => {
  const messages = [
    { role: 'tool', name: 'web_fetch', content: 'unstructured result '.repeat(100) },
    { role: 'tool', name: 'fs_read', content: 'recent' }
  ];
  pruneStaleToolObservations(messages, { keepRecent: 1 });
  assert.match(messages[0]?.content ?? '', /outcome unverified/);
  assert.doesNotMatch(messages[0]?.content ?? '', /succeeded|completed/);
});

test('spilling disabled keeps original content rather than destroying it', () => {
  const prior = process.env.CAUSYNE_OUTPUT_SPILL;
  process.env.CAUSYNE_OUTPUT_SPILL = '0';
  try {
    const original = 'important result '.repeat(100);
    const messages = [
      { role: 'tool', name: 'fs_read', content: original },
      { role: 'tool', name: 'fs_read', content: 'recent' }
    ];
    const result = pruneStaleToolObservations(messages, { keepRecent: 1 });
    assert.equal(result.spillFailures, 1);
    assert.equal(messages[0]?.content, original);
  } finally {
    if (prior === undefined) delete process.env.CAUSYNE_OUTPUT_SPILL;
    else process.env.CAUSYNE_OUTPUT_SPILL = prior;
  }
});

test('compacted history retains a bounded recovery index without inventing success', () => {
  const messages = Array.from({ length: 12 }, (_, index) => ({
    role: 'tool', name: 'fs_read', content: `unknown ${index} ${'x'.repeat(800)}`
  }));
  pruneStaleToolObservations(messages, { keepRecent: 1, taskId: 'summary' });
  const summary = buildRecoverableDroppedSummary(messages.slice(0, 11), 'Previous inspection occurred.', 3);
  assert.match(summary, /Previous inspection occurred/);
  assert.match(summary, /11 saved/);
  assert.match(summary, /8 older saved outputs omitted/);
  assert.equal((summary.match(/outcome unverified/g) ?? []).length, 3);
  assert.ok(summary.includes(messages[10]?.spillPath ?? 'missing path'));
  assert.ok(!summary.includes(messages[0]?.spillPath ?? 'missing path'));
});

test('repeated compaction carries prior recovery pointers forward', () => {
  const oldPath = '/private/outputs/earlier.json';
  const newerPath = '/private/outputs/newer.json';
  const first = `Recoverable prior tool output (1 saved; local files expire after retention):\nfs_read (outcome unverified): ${oldPath}`;
  const dropped = [
    { role: 'user', content: `[COMPACTED CONTEXT SUMMARY — 10 earlier messages were condensed to protect the context window]\n${first}` },
    { role: 'tool', name: 'fs_read', content: '{"success":false}', spillPath: newerPath }
  ];
  const second = buildRecoverableDroppedSummary(dropped, 'Later work occurred.');
  assert.match(second, /2 saved/);
  assert.ok(second.includes(oldPath));
  assert.ok(second.includes(`fs_read (reported failure): ${newerPath}`));
});

test('oversized recent tool output is shortened only with a full recovery copy', () => {
  const original = `start\n${'x'.repeat(62_000)}\nend`;
  const messages = [{ role: 'tool', name: 'fs_read', content: original, tool_call_id: 'recent' }];
  const result = shortenOversizedToolObservations(messages, { taskId: 'recent' });
  assert.equal(result.pruned, 1);
  assert.ok(messages[0]?.content.length < 6000);
  assert.equal(messages[0]?.tool_call_id, 'recent');
  assert.equal(fs.readFileSync(messages[0]?.spillPath ?? '', 'utf8'), original);
});

test('oversized tool output remains intact if spill fails', () => {
  const prior = process.env.CAUSYNE_OUTPUT_SPILL;
  process.env.CAUSYNE_OUTPUT_SPILL = '0';
  try {
    const original = 'x'.repeat(61_000);
    const messages = [{ role: 'tool', name: 'fs_read', content: original }];
    const result = shortenOversizedToolObservations(messages);
    assert.equal(result.pruned, 0);
    assert.equal(result.spillFailures, 1);
    assert.equal(messages[0]?.content, original);
  } finally {
    if (prior === undefined) delete process.env.CAUSYNE_OUTPUT_SPILL;
    else process.env.CAUSYNE_OUTPUT_SPILL = prior;
  }
});

test('observations exceeding 2,500 chars are shortened by default to preserve context', () => {
  const original = `start\n${'y'.repeat(5_000)}\nend`;
  const messages = [{ role: 'tool', name: 'fs_read', content: original, tool_call_id: 'dtoc_call' }];
  const result = shortenOversizedToolObservations(messages, { taskId: 'dtoc_task' });
  assert.equal(result.pruned, 1);
  assert.ok(messages[0]?.content.length < 3500);
  assert.equal(fs.readFileSync(messages[0]?.spillPath ?? '', 'utf8'), original);
});

test('executed file arguments are archived once, with complete contents and stable call pairing', () => {
  const source = Array.from({ length: 600 }, (_, index) => `export const value${index} = ${index};`).join('\n');
  const first = { id: 'first-write', function: { name: 'fs_write', arguments: JSON.stringify({ path: 'first.ts', content: source }) } };
  const second = { id: 'second-write', function: { name: 'fs_write', arguments: JSON.stringify({ path: 'second.ts', content: source + '\n// second file' }) } };
  const pending = { id: 'pending-write', function: { name: 'fs_write', arguments: JSON.stringify({ path: 'pending.ts', content: source }) } };
  const pendingOriginal = pending.function.arguments;
  const userText = 'The user requires this full text: ' + source;
  const messages = [
    { role: 'user', content: userText },
    { role: 'assistant', content: '', tool_calls: [first, second, pending] },
    { role: 'tool', name: 'fs_write', tool_call_id: 'first-write', content: '{"success":true}' },
    { role: 'tool', name: 'fs_write', tool_call_id: 'second-write', content: '{"success":true}' }
  ];
  const originalLength = first.function.arguments.length + second.function.arguments.length;
  const result = pruneExecutedToolArguments(messages, { taskId: 'file-arguments' });
  assert.equal(result.pruned, 2);
  assert.equal(result.spillFailures, 0);
  assert.ok(result.reclaimedChars > originalLength * 0.9);
  assert.equal(messages[0]?.content, userText);
  assert.equal(pending.function.arguments, pendingOriginal, 'never archive a request that has not executed');
  assert.equal(first.id, messages[2]?.tool_call_id);
  const savedFirst = JSON.parse(first.function.arguments)._causyne_archived_args;
  const savedSecond = JSON.parse(second.function.arguments)._causyne_archived_args;
  assert.notEqual(savedFirst, savedSecond, 'same-step writes must not overwrite one another');
  assert.ok(fs.readFileSync(savedFirst, 'utf8').includes(source));
  assert.ok(fs.readFileSync(savedSecond, 'utf8').includes(source + '\n// second file'));
  assert.equal(JSON.parse(first.function.arguments).path, 'first.ts');
  const repeat = pruneExecutedToolArguments(messages, { taskId: 'file-arguments' });
  assert.equal(repeat.pruned, 0);
  assert.deepEqual(repeat.recoveryPaths, [savedFirst, savedSecond]);
  const summary = buildRecoverableDroppedSummary(messages, 'Two writes were attempted.');
  assert.ok(summary.includes(savedFirst));
  assert.ok(summary.includes(savedSecond));
  assert.match(summary, /arguments \(outcome unverified\)/);
});

test('executed arguments remain intact if their recovery copy cannot be saved', () => {
  const prior = process.env.CAUSYNE_OUTPUT_SPILL;
  process.env.CAUSYNE_OUTPUT_SPILL = '0';
  try {
    const original = JSON.stringify({ path: 'app.ts', content: 'important code\n'.repeat(1500) });
    const call = { id: 'blocked-spill', function: { name: 'fs_write', arguments: original } };
    const result = pruneExecutedToolArguments([
      { role: 'assistant', content: '', tool_calls: [call] },
      { role: 'tool', content: '{"success":true}', tool_call_id: 'blocked-spill' }
    ]);
    assert.equal(result.pruned, 0);
    assert.equal(result.spillFailures, 1);
    assert.equal(call.function.arguments, original);
  } finally {
    if (prior === undefined) delete process.env.CAUSYNE_OUTPUT_SPILL;
    else process.env.CAUSYNE_OUTPUT_SPILL = prior;
  }
});

