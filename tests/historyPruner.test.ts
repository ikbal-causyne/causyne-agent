import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-history-prune-'));
const previousHome = process.env.CAUSYNE_HOME;
process.env.CAUSYNE_HOME = root;
const { buildRecoverableDroppedSummary, pruneStaleToolObservations, shortenOversizedToolObservations } = await import('../src/historyPruner.ts');

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

