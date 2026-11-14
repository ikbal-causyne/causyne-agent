import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computerUse } from '../src/tools/computerUse.js';
import { desktopAct } from '../src/tools/desktopAct.js';

test('malformed click and type target coordinates never actuate another focused element', async () => {
  const original = desktopAct.execute;
  let called = false;
  desktopAct.execute = async () => { called = true; return { success: true }; };
  try {
    for (const coordinates of [[1], [1, 2, 3], [NaN, 5], [Infinity, 1]]) {
      const action = await computerUse.execute({ action: 'click', coordinates });
      assert.equal(action.success, false);
      assert.match(action.error ?? '', /coordinates/i);
      const typed = await computerUse.execute({ action: 'type', coordinates, text: 'secret' });
      assert.equal(typed.success, false);
      assert.match(typed.error ?? '', /coordinates/i);
    }
    assert.equal(called, false);
  } finally { desktopAct.execute = original; }
});

test('unsupported key chords never become literal text typing', async () => {
  const original = desktopAct.execute;
  let called = false;
  desktopAct.execute = async () => { called = true; return { success: true }; };
  try {
    const result = await computerUse.execute({ action: 'key', key: 'cmd+c' });
    assert.equal(result.success, false);
    assert.match(result.error ?? '', /Unsupported key/i);
    assert.equal(called, false);
  } finally { desktopAct.execute = original; }
});

test('key action trims surrounding whitespace and rejects blank keys', async () => {
  const original = desktopAct.execute;
  const recorded: unknown[] = [];
  desktopAct.execute = async (args: unknown) => { recorded.push(args); return { success: true }; };
  try {
    const blank = await computerUse.execute({ action: 'key', key: '   ' });
    assert.equal(blank.success, false);
    assert.match(blank.error ?? '', /requires "key"/i);
    assert.equal(recorded.length, 0);

    const padded = await computerUse.execute({ action: 'key', key: '  return  ' });
    assert.equal(padded.success, true);
    assert.deepEqual(padded.actions, [{ verb: 'key', keyCode: 36 }]);
  } finally { desktopAct.execute = original; }
});
