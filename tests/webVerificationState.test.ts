import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildToolsList } from '../src/toolsList.js';
import { decideTools } from '../src/decideTools.js';
import { AgentLoop } from '../src/agentLoop.js';

test('buildToolsList returns all curated tools when called without arguments', () => {
  const tools = buildToolsList();
  assert.ok(tools.length > 50, `Expected over 50 curated tools, got ${tools.length}`);
  const names = new Set(tools.map((t) => t.name));
  assert.ok(names.has('browser_act'), 'Expected browser_act in curated list');
  assert.ok(names.has('sysRun'), 'Expected sysRun in curated list');
  assert.ok(names.has('fs_write'), 'Expected fs_write in curated list');
});

test('decideTools admits domain packs and tools on intent matching', () => {
  const list = buildToolsList();
  const decision = decideTools({
    source: 'intent',
    list,
    prompt: 'build me a city in three.js horse world simulator'
  });

  assert.equal(decision.archetype, 'web_engineering');
  assert.ok(decision.packs.includes('web'), 'Expected web pack to be admitted');
  assert.ok(decision.tools.includes('browser_act'), 'Expected browser_act in admitted tools');
  assert.ok(decision.tools.includes('fs_write'), 'Expected fs_write in admitted tools');
});

test('recordWebArtifact does not wipe browser verification when editing tests or backend scripts', () => {
  const loop = new AgentLoop({
    workspaceRoot: process.cwd(),
    userPrompt: 'build me a city in three.js horse world simulator',
    config: { autonomyMode: 'full' },
    llm: { supportsVision: true }
  });

  // Simulate successful prior browser inspection
  loop.webVerificationState.browserActUsed = true;
  loop.webVerificationState.screenshotTaken = true;

  // Editing a unit test file must NOT invalidate browser verification
  loop.recordWebArtifact('horse-simulator-3d/test.js');
  assert.equal(loop.webVerificationState.browserActUsed, true, 'browserActUsed must remain true when touching test.js');
  assert.equal(loop.webVerificationState.screenshotTaken, true, 'screenshotTaken must remain true when touching test.js');

  // Editing Python solver or dataset must NOT invalidate browser verification
  loop.recordWebArtifact('horse-simulator-3d/kinematics.py');
  assert.equal(loop.webVerificationState.browserActUsed, true, 'browserActUsed must remain true when touching kinematics.py');

  loop.recordWebArtifact('horse-simulator-3d/baked_kinematics.json');
  assert.equal(loop.webVerificationState.browserActUsed, true, 'browserActUsed must remain true when touching json dataset');

  // Editing the actual HTML document SHOULD reset browser verification for fresh snapshot
  loop.recordWebArtifact('horse-simulator-3d/index.html');
  assert.equal(loop.webVerificationState.browserActUsed, false, 'browserActUsed should reset when index.html changes');
  assert.equal(loop.webVerificationState.screenshotTaken, false, 'screenshotTaken should reset when index.html changes');
});
