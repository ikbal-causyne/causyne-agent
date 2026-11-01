import test from 'node:test';
import assert from 'node:assert/strict';
import { determineToolScope } from '../src/smartToolsUse.js';
import { AgentLoop } from '../src/agentLoop.js';

test('Archetype Sizing for 3D City and Game Simulation Tasks', () => {
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
  }
});

test('AgentLoop resolves archetype correctly when userPrompt is set without currentTaskPrompt', () => {
  const loop = new AgentLoop({
    provider: 'ollama',
    model: 'mock'
  });

  loop.userPrompt = 'build 3d city simulation in nyc-3d';
  assert.ok(!loop.currentTaskPrompt);

  const promptForArchetype = (loop.currentTaskPrompt || loop.userPrompt || '').trim();
  const archetype = determineToolScope(promptForArchetype).archetype;
  assert.equal(archetype, 'game_development');
});
