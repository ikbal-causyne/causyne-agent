import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSingleAction,
  visionGroundingToDesktopAct
} from '../src/computerUse/visionGrounding.js';

test('BUG-04 baseline: compound hotkey chord must not type literal text string', () => {
  const hotkeyCopy = parseSingleAction("Action: hotkey(key='cmd+c')");
  assert.ok(hotkeyCopy !== null);
  assert.equal(hotkeyCopy.action, 'hotkey');

  const acts = visionGroundingToDesktopAct([hotkeyCopy]);
  assert.ok(acts.length > 0, 'Hotkeys must produce an actuation event');

  // In the unfixed code, MAC_KEY_CODES['cmd+c'] is undefined, so it emits { verb: 'type', text: 'cmd+c' }
  const typedLiteralString = acts.some(a => a.verb === 'type' && a.text === 'cmd+c');
  assert.equal(
    typedLiteralString,
    false,
    `compound hotkey cmd+c was converted into typing the literal string "cmd+c"! (BUG-04)`
  );
});
