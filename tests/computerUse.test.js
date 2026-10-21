import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractCoordinateNumbers,
  groundPoint,
  groundBoxCenter,
  parseSingleAction,
  parseVisionGroundingPrediction,
  visionGroundingToDesktopAct
} from '../src/computerUse/visionGrounding.js';
import { computerUse } from '../src/tools/computerUse.js';
import { TOOL_DEFINITIONS, toolRegistry } from '../src/tools/registry.js';

test('computer use: coordinate extraction handles various bracket and number formats', () => {
  assert.deepEqual(extractCoordinateNumbers('(500, 300)'), [500, 300]);
  assert.deepEqual(extractCoordinateNumbers('[120.5, 450.2, 300, 600]'), [120.5, 450.2, 300, 600]);
  assert.deepEqual(extractCoordinateNumbers(''), []);
});

test('computer use: coordinate grounding translates normalized values to screen resolution', () => {
  const screen = { width: 1920, height: 1080, scaleFactor: 1 };
  const pt = groundPoint([500, 500], screen);
  assert.ok(pt);
  assert.equal(pt.x, 960);
  assert.equal(pt.y, 540);

  const boxCenter = groundBoxCenter([0, 0, 1000, 1000], screen);
  assert.ok(boxCenter);
  assert.equal(boxCenter.x, 960);
  assert.equal(boxCenter.y, 540);
});

test('computer use: single action parsing handles standard vision grounding syntax', () => {
  const screen = { width: 1920, height: 1080, scaleFactor: 1 };

  const clickAct = parseSingleAction("click(start_box='(200, 400)')", screen);
  assert.ok(clickAct);
  assert.equal(clickAct.action, 'click');
  assert.ok(clickAct.coordinates);
  assert.equal(clickAct.coordinates.x, 384);
  assert.equal(clickAct.coordinates.y, 432);

  const typeAct = parseSingleAction("type(content='Causyne Agent', start_box='(100, 100)')", screen);
  assert.ok(typeAct);
  assert.equal(typeAct.action, 'type');
  assert.equal(typeAct.text, 'Causyne Agent');

  const hotkeyAct = parseSingleAction("hotkey(key='return')", screen);
  assert.ok(hotkeyAct);
  assert.equal(hotkeyAct.action, 'hotkey');
  assert.equal(hotkeyAct.key, 'return');

  const waitAct = parseSingleAction("wait(seconds='2.5')", screen);
  assert.ok(waitAct);
  assert.equal(waitAct.action, 'wait');
  assert.equal(waitAct.seconds, 2.5);
});

test('computer use: multi-line prediction with thoughts parses cleanly into desktop acts', () => {
  const prediction = `
Thought: I need to click the search bar and submit query.
Action: click(start_box='(500, 200)')

Action: type(content='autonomous agent')

Action: hotkey(key='return')
`;

  const parsed = parseVisionGroundingPrediction(prediction, { width: 1000, height: 1000, scaleFactor: 1 });
  assert.equal(parsed.thought, 'I need to click the search bar and submit query.');
  assert.equal(parsed.actions.length, 3);
  assert.equal(parsed.actions[0].action, 'click');
  assert.equal(parsed.actions[1].action, 'type');
  assert.equal(parsed.actions[2].action, 'hotkey');

  const desktopActs = visionGroundingToDesktopAct(parsed.actions);
  assert.equal(desktopActs.length, 3);
  assert.equal(desktopActs[0].verb, 'clickxy');
  assert.equal(desktopActs[1].verb, 'type');
  assert.equal(desktopActs[2].verb, 'key');
});

test('computer use: tool schema and registry integration', () => {
  assert.ok(toolRegistry.computer_use, 'computer_use missing from toolRegistry');
  const def = TOOL_DEFINITIONS.find((t) => t.name === 'computer_use');
  assert.ok(def, 'computer_use missing from TOOL_DEFINITIONS');
  assert.equal(typeof computerUse.execute, 'function');
});
