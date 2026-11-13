import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { defaultObserver } from '../src/observer.js';
import { windowSnapshot, MAX_SNAPSHOT_CHARS } from '../src/browser/snapshotWindow.js';
import { computerUse } from '../src/tools/computerUse.js';
import { desktopAct } from '../src/tools/desktopAct.js';

test('local verification accepts bracketed IPv6 loopback addresses', async t => {
  const server = http.createServer((_req, res) => res.end('ok'));
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '::1', resolve);
    });
  } catch (error) {
    if (['EADDRNOTAVAIL', 'EAFNOSUPPORT'].includes((error as NodeJS.ErrnoException).code ?? '')) {
      t.skip('IPv6 loopback is unavailable on this host'); return;
    }
    throw error;
  }
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const result = await defaultObserver.verifyLocalWeb({ endpoint: `http://[::1]:${address.port}/` });
    assert.equal(result.verified, true);
    assert.equal(result.statusCode, 200);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('browser snapshot invalid offsets produce a valid first page and continuation', () => {
  const text = 'abcdef'.repeat(MAX_SNAPSHOT_CHARS);
  for (const offset of [NaN, Infinity, -Infinity]) {
    const page = windowSnapshot(text, offset);
    assert.equal(page.offset, 0);
    assert.equal(page.hasMore, true);
    assert.ok(Number.isFinite(page.nextOffset));
    assert.equal(page.text, windowSnapshot(text, 0).text);
    assert.ok(page.text.length <= MAX_SNAPSHOT_CHARS);
  }
});

test('computer-use wait clamps zero to its minimum and defaults non-finite values', async () => {
  const original = desktopAct.execute;
  const observed: number[] = [];
  desktopAct.execute = async (args: { actions: Array<{ seconds: number }> }) => {
    observed.push(args.actions[0]!.seconds);
    return { success: true };
  };
  try {
    for (const seconds of [0, -1, 0.5, 20, NaN, Infinity]) {
      assert.equal((await computerUse.execute({ action: 'wait', seconds })).success, true);
    }
    assert.deepEqual(observed, [0.1, 0.1, 0.5, 10, 1, 1]);
  } finally { desktopAct.execute = original; }
});
