import { test } from 'node:test';
import assert from 'node:assert/strict';
import { desktopAct } from '../src/tools/desktopAct.js';

test('modifier chords are rejected instead of becoming unmodified key presses', async () => {
  const outcome = await desktopAct.execute({
    app: 'Notes',
    actions: [{ verb: 'key', keyCode: 8, key: 'c', chord: 'cmd+c', modifiers: ['cmd'] }]
  });
  assert.equal(outcome.success, false);
  assert.match(outcome.error ?? '', /modifier key chords/i);
});

test('non-integer and out-of-range virtual key codes are rejected before OS actuation', async () => {
  for (const keyCode of [NaN, Infinity, -1, 128, 2.5]) {
    const outcome = await desktopAct.execute({ app: 'Notes', actions: [{ verb: 'key', keyCode }] });
    assert.equal(outcome.success, false);
    assert.match(outcome.error ?? '', /virtual key code/i);
  }
});
