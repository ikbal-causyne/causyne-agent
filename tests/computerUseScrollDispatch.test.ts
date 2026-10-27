import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSingleAction,
  visionGroundingToDesktopAct
} from '../src/computerUse/visionGrounding.js';

test('BUG-02 baseline: scroll actions must translate into executable desktop events', () => {
  const scrollDown = parseSingleAction("Action: scroll(direction='down')");
  assert.ok(scrollDown !== null, 'parseSingleAction must parse scroll action');
  assert.equal(scrollDown.action, 'scroll');
  assert.equal(scrollDown.direction, 'down');

  // Translate to desktop actuator actions
  const acts = visionGroundingToDesktopAct([scrollDown]);

  // In the unfixed code, visionGroundingToDesktopAct has no case 'scroll' and returns []
  assert.ok(
    acts.length > 0,
    `visionGroundingToDesktopAct returned 0 actions for scroll! Unhandled action dropped silently (BUG-02).`
  );
  assert.ok(
    acts.some(a => a.verb === 'scroll' || (a.verb as string) === 'key'),
    'acts must contain a scroll or key event'
  );
});
