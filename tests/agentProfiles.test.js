import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {
  agentProfilesRoot,
  listAgentProfiles,
  loadAgentProfile
} from '../src/agentProfiles.js';
import { subagentOrchestrator } from '../src/tools/subagentOrchestrator.js';
import { AgentLoop } from '../src/agentLoop.js';

function writeProfile(name, overrides = {}) {
  const root = agentProfilesRoot();
  fs.mkdirSync(root, { recursive: true });
  const value = {
    schemaVersion: 1,
    name,
    description: 'Reviews a bounded part of the current workspace.',
    instructions: 'Inspect evidence carefully and report only verified findings.',
    toolScope: ['fs.read', 'fs_search'],
    maxSteps: 12,
    maxTokens: 20_000,
    ...overrides
  };
  fs.writeFileSync(path.join(root, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
}

test('agent profiles: static manifests validate and normalize their tool ceiling', () => {
  writeProfile('reviewer');
  const loaded = loadAgentProfile('reviewer');
  assert.equal(loaded.ok, true);
  assert.deepEqual(loaded.profile.toolScope, ['fs_read', 'fs_search']);
  assert.equal(loaded.profile.maxSteps, 12);
  assert.equal(loaded.profile.maxTokens, 20_000);
});

test('agent profiles: traversal, malformed JSON, and symlinks are refused', () => {
  assert.equal(loadAgentProfile('../outside').ok, false);
  fs.mkdirSync(agentProfilesRoot(), { recursive: true });
  fs.writeFileSync(path.join(agentProfilesRoot(), 'broken.json'), '{');
  assert.equal(loadAgentProfile('broken').ok, false);

  const target = path.join(agentProfilesRoot(), 'target.json');
  fs.writeFileSync(target, '{}');
  fs.symlinkSync(target, path.join(agentProfilesRoot(), 'linked.json'));
  assert.equal(loadAgentProfile('linked').ok, false);
});

test('agent profiles: listing exposes capabilities but not private instructions', async () => {
  writeProfile('auditor');
  const listed = listAgentProfiles();
  assert.ok(listed.profiles.some(profile => profile.name === 'auditor'));

  const result = await subagentOrchestrator.execute({ action: 'list_profiles' });
  assert.equal(result.success, true);
  assert.match(result.output, /auditor/);
  assert.doesNotMatch(result.output, /Inspect evidence carefully/);
});

test('agent profiles: an unknown profile fails before any agent loop starts', async () => {
  const result = await subagentOrchestrator.execute({
    action: 'delegate_and_wait',
    profile: 'missing-profile',
    prompt: 'Inspect one file.'
  });
  assert.equal(result.success, false);
  assert.match(result.error, /Agent profile.*missing-profile/);
});

test('subagent ceilings survive the AgentLoop config refresh performed by run()', () => {
  const loop = new AgentLoop(null, 'ceiling-test', 'inspect');
  loop.maxStepsCeiling = 7;
  loop.taskTokenLimit = 4_000;
  loop.updateTierLimits();
  assert.equal(loop.maxSteps, 7);
  assert.equal(loop.maxCircuitBreaker, 7);
  assert.equal(loop.tokenTracker.budget.enabled, true);
  assert.equal(loop.tokenTracker.budget.hardStop, true);
  assert.equal(loop.tokenTracker.budget.maxTokensPerTask, 4_000);
});
