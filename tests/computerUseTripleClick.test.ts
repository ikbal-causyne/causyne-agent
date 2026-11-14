import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSingleAction,
  visionGroundingToDesktopAct
} from '../src/computerUse/visionGrounding.js';

test('triple_click emits three sequential clickxy actuations at the grounded coordinate', () => {
  const action = parseSingleAction("Action: triple_click(start_box='(250, 500)')", {
    width: 1000,
    height: 1000,
    scaleFactor: 1
  });
  assert.ok(action !== null);
  assert.equal(action.action, 'triple_click');

  const acts = visionGroundingToDesktopAct([action]);
  assert.deepEqual(acts, [
    { verb: 'clickxy', x: 250, y: 500 },
    { verb: 'clickxy', x: 250, y: 500 },
    { verb: 'clickxy', x: 250, y: 500 }
  ]);
});
