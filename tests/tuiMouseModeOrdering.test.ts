import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mouseTracking, KeyDecoder } from '../src/tui/keys.js';

test('SGR encoding precedes tracking on enable and outlives tracking on disable', () => {
  assert.equal(mouseTracking(true), '\x1b[?1006h\x1b[?1000h');
  assert.equal(mouseTracking(false), '\x1b[?1000l\x1b[?1006l');
});

test('wheel reports remain ordinary decoded input rather than terminal-native scroll intent', () => {
  const decoder = new KeyDecoder();
  const up = decoder.decode(Buffer.from('\x1b[<64;23;12M'));
  const down = decoder.decode(Buffer.from('\x1b[<65;23;12M'));
  assert.equal(up[0]?.name, 'wheel');
  assert.equal(up[0]?.wheel?.direction, 'up');
  assert.equal(down[0]?.name, 'wheel');
  assert.equal(down[0]?.wheel?.direction, 'down');
});
