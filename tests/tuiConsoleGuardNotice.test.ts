import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setTransientNotice } from '../src/tui/consoleGuard.js';

describe('consoleGuard setTransientNotice bounds', () => {
  it('avoids 1ms Node timer overflow on non-finite and oversized ttlMs', () => {
    const prevSetTimeout = globalThis.setTimeout;
    const prevClearTimeout = globalThis.clearTimeout;
    const delays: Array<number | undefined> = [];

    const host = { notice: '', scheduleDraw() {} };

    try {
      globalThis.setTimeout = ((_fn: () => void, delay?: number) => {
        delays.push(delay);
        return { unref() {} };
      }) as unknown as typeof setTimeout;
      globalThis.clearTimeout = (() => {}) as typeof clearTimeout;

      setTransientNotice(host, 'NaN notice', Number.NaN);
      assert.equal(delays.at(-1), 4000);

      const countBeforeInf = delays.length;
      setTransientNotice(host, 'Persistent notice', Number.POSITIVE_INFINITY);
      assert.equal(delays.length, countBeforeInf);

      setTransientNotice(host, 'Long notice', 1e12);
      assert.equal(delays.at(-1), 2_147_483_647);
    } finally {
      setTransientNotice(host, '', 0);
      globalThis.setTimeout = prevSetTimeout;
      globalThis.clearTimeout = prevClearTimeout;
    }
  });
});
