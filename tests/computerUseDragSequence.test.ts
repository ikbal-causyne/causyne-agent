import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSingleAction,
  visionGroundingToDesktopAct
} from '../src/computerUse/visionGrounding.js';

test('BUG-03 baseline: drag action must emit continuous drag sequence, not two independent clicks', () => {
  const dragAction = parseSingleAction("Action: drag(start_box='(100, 100)', end_box='(300, 300)')", {
    width: 1000,
    height: 1000,
    scaleFactor: 1
  });

  assert.ok(dragAction !== null);
  assert.equal(dragAction.action, 'drag');

  const acts = visionGroundingToDesktopAct([dragAction]);

  // In the unfixed code, acts is [{ verb: 'clickxy', x: 100, y: 100 }, { verb: 'clickxy', x: 300, y: 300 }]
  // Two clicks do NOT constitute a drag. It must be a drag verb or mousedown -> move -> mouseup.
  const isBrokenTwoClicks = acts.length === 2 && acts.every(a => a.verb === 'clickxy');
  assert.equal(
    isBrokenTwoClicks,
    false,
    `drag action was degraded into two independent clicks! Continuous drag sequence required (BUG-03).`
  );
});
