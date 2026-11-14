import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectLinkAtPoint,
  openDetectedLink,
  resetLinkOpenDebounceForTests,
  type SmartLinkSurface
} from '../src/tui/smartLinkClick.js';
import type { MessageMarker } from '../src/tui/messageInteraction.js';

describe('smartLinkClick finite and integer bounds', () => {
  it('detectLinkAtPoint floors fractional coordinates and handles non-finite scrollTop and out.rows', () => {
    const rowWithLink = '  Live: https://example.com/demo ready';
    const marker: MessageMarker = {
      id: 1,
      kind: 'assistant',
      row: 0,
      meta: { messageText: rowWithLink }
    };
    const makeSurface = (scrollTop: number, outRows: number): SmartLinkSurface => ({
      width: 100,
      out: { rows: outRows },
      stage: { height: 10, reserved: true },
      viewport: { height: 5, width: 97, scrollTop },
      transcript: { flatten: () => ({ rows: [rowWithLink], markers: [marker] }) }
    });

    const fractionalHit = detectLinkAtPoint(makeSurface(0, 20), { x: 15.8, y: 14.7 }, marker);
    assert.equal(fractionalHit?.url, 'https://example.com/demo');

    const nanScrollHit = detectLinkAtPoint(makeSurface(Number.NaN, 20), { x: 15, y: 14 }, marker);
    assert.equal(nanScrollHit?.url, 'https://example.com/demo');

    const infOutRowsHit = detectLinkAtPoint(
      makeSurface(0, Number.POSITIVE_INFINITY),
      { x: 15, y: 4 },
      marker
    );
    assert.equal(infOutRowsHit?.url, 'https://example.com/demo');
  });

  it('openDetectedLink falls back safely when now or debounceMs is non-finite', () => {
    resetLinkOpenDebounceForTests();
    let launches = 0;
    const spawnStub = (() => {
      launches++;
      return { on() {}, unref() {} };
    }) as never;

    openDetectedLink('https://example.com/debounce-test', {
      platform: 'darwin',
      now: Number.NaN,
      spawnImpl: spawnStub
    });
    // Second rapid click with valid clock or NaN debounceMs should still be debounced.
    openDetectedLink('https://example.com/debounce-test', {
      platform: 'darwin',
      debounceMs: Number.NaN,
      spawnImpl: spawnStub
    });
    assert.equal(launches, 1);
  });

  it('openDetectedLink does not poison debounce when spawn throws or clock moves backward', () => {
    resetLinkOpenDebounceForTests();
    const throwingSpawn = (() => {
      throw new Error('spawn failed');
    }) as never;

    const first = openDetectedLink('https://example.com/retry-test', {
      platform: 'darwin',
      now: 1000,
      spawnImpl: throwingSpawn
    });
    assert.equal(first, false);

    let launches = 0;
    const workingSpawn = (() => {
      launches++;
      return { on() {}, unref() {} };
    }) as never;

    const retry = openDetectedLink('https://example.com/retry-test', {
      platform: 'darwin',
      now: 1050,
      spawnImpl: workingSpawn
    });
    assert.equal(retry, true);
    assert.equal(launches, 1);

    const earlierClock = openDetectedLink('https://example.com/retry-test', {
      platform: 'darwin',
      now: 500,
      spawnImpl: workingSpawn
    });
    assert.equal(earlierClock, true);
    assert.equal(launches, 2);
  });
});
