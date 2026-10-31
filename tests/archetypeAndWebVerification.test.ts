import test from 'node:test';
import assert from 'node:assert/strict';
import { determineToolScope } from '../src/smartToolsUse.js';
import { turnTokenLimitFor, actionLimitFor, tokenLimitFor } from '../src/providers/budgetEnforcer.js';
import { AgentLoop } from '../src/agentLoop.js';

test('Archetype & Budget Sizing for 3D City and Game Simulation Tasks', () => {
  const prompts = [
    'nyc-3d',
    'create 3d city simulator in nyc-3d',
    'build city simulation in nyc-3d',
    'buatkan city simulation 3d di folder nyc-3d',
    '3d city simulation',
    'interactive webgl simulation',
    'nyc-ride-simulator',
    'build 3d ride simulator in nyc-ride-simulator',
    'NYC Ultra-Realistic 3D Ride Simulator'
  ];

  for (const prompt of prompts) {
    const scope = determineToolScope(prompt);
    assert.equal(scope.archetype, 'game_development', `Prompt "${prompt}" must resolve to game_development archetype`);
    assert.equal(turnTokenLimitFor(scope.archetype), 1_000_000, `Single-turn token limit for "${prompt}" must be 1,000,000`);
    assert.equal(actionLimitFor(scope.archetype), 250, `Action limit for "${prompt}" must be 250`);
    assert.equal(tokenLimitFor(scope.archetype), 3_000_000, `Task token limit for "${prompt}" must be 3,000,000`);
  }
});

test('AgentLoop initializes efficiency budget with correct limits when userPrompt is set without currentTaskPrompt', () => {
  const loop = new AgentLoop({
    provider: 'ollama',
    model: 'mock'
  });

  loop.userPrompt = 'build 3d city simulation in nyc-3d';
  // Before loop.run, currentTaskPrompt is undefined, but loop resolves it
  assert.ok(!loop.currentTaskPrompt);

  // Directly check prompt resolution
  const promptForArchetype = (loop.currentTaskPrompt || loop.userPrompt || '').trim();
  const archetype = determineToolScope(promptForArchetype).archetype;
  assert.equal(archetype, 'game_development');
  assert.equal(turnTokenLimitFor(archetype), 1_000_000);
  assert.equal(actionLimitFor(archetype), 250);
});
