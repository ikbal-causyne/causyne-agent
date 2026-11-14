import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatAnimatedStatus, getAngle, renderCausyneRotor, startCausyneRotor } from '../src/tui/CausyneRotor.js';

describe('CausyneRotor finite bounds', () => {
  it('getAngle and renderCausyneRotor sanitize non-finite elapsedMs, columns, and rows', () => {
    assert.ok(Number.isFinite(getAngle(Number.NaN)));
    assert.ok(Number.isFinite(getAngle(Number.POSITIVE_INFINITY)));

    const frame = renderCausyneRotor(Number.NaN, {
      columns: Number.NaN,
      rows: Number.POSITIVE_INFINITY,
      label: 'run'
    });
    assert.ok(frame.length > 0);
    assert.ok(frame.split('\n').length >= 6);
  });

  it('startCausyneRotor falls back to finite 16fps interval when fps is non-finite', () => {
    const prevIsTTY = process.stdout.isTTY;
    const prevWrite = process.stdout.write.bind(process.stdout);
    const prevSetInterval = globalThis.setInterval;
    const prevClearInterval = globalThis.clearInterval;
    let recordedDelay: number | undefined;

    try {
      Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
      process.stdout.write = (() => true) as typeof process.stdout.write;
      globalThis.setInterval = ((_fn: () => void, delay?: number) => {
        recordedDelay = delay;
        return 123;
      }) as unknown as typeof setInterval;
      globalThis.clearInterval = (() => {}) as typeof clearInterval;

      const handle = startCausyneRotor({ fps: Number.NaN, color: false });
      handle.stop();
      assert.equal(recordedDelay, Math.round(1000 / 16));
    } finally {
      Object.defineProperty(process.stdout, 'isTTY', { value: prevIsTTY, configurable: true });
      process.stdout.write = prevWrite;
      globalThis.setInterval = prevSetInterval;
      globalThis.clearInterval = prevClearInterval;
    }
  });

  it('sanitizes control sequences and non-finite ticks in rotor label and animated status', () => {
    const frame = renderCausyneRotor(0, { columns: 12, rows: 6, color: false, label: 'run\x1b[2J\nmore' });
    assert.equal(frame.includes('\x1b[2J'), false);
    assert.equal(frame.split('\n').length, 7);
    assert.equal(frame.split('\n').at(-1), '● run more');

    const status = formatAnimatedStatus('sync\x1b[31m\nnext', Number.NaN);
    assert.equal(status, 'sync next   ');
  });
});
