import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  determineToolScope,
  filterSuppressedPacks,
  resolveLazyPlaybooks
} from '../src/smartToolsUse.js';
import { resolveActiveTools } from '../src/toolPacks.js';

test('determineToolScope correctly identifies desktop personalization intent', () => {
  const userPrompt =
    'please searching web and download for my desktop puctures and change my desktop picture according to my mood my mood now is bias i want my life bteer have money so much and kejaiaan kedmaiaan angin berhembus sepoi sepi di padang umput luas dan luasnyaa laautan musim dingin dan indahnya antartika kedamian kebebasan dari semau belenggu yang memebelenggu damai indah berjya hidup indah selamnaya';

  const scope = determineToolScope(userPrompt);

  assert.equal(scope.archetype, 'desktop_personalization');
  assert.ok(scope.toolScope instanceof Set);
  assert.ok(scope.toolScope.has('sysRun'));
  assert.ok(scope.toolScope.has('web_search'));
  assert.ok(scope.toolScope.has('web_fetch'));
  assert.ok(scope.toolScope.has('fs_write'));
  assert.ok(scope.toolScope.has('tool_search'));

  // Should NOT contain heavy unneeded tools
  assert.equal(scope.toolScope.has('blender_act'), false);
  assert.equal(scope.toolScope.has('ui_forge'), false);
  assert.equal(scope.toolScope.has('godot_act'), false);

  // Verifies pack suppression
  assert.ok(scope.suppressedPacks.includes('media'));
  assert.ok(scope.suppressedPacks.includes('web'));
  assert.ok(scope.suppressedPacks.includes('game'));
});

test('determineToolScope correctly identifies pure web research intent without UI development', () => {
  const prompt = 'search the web for the latest updates on Node.js 22 LTS features and summarize them';
  const scope = determineToolScope(prompt);

  assert.equal(scope.archetype, 'web_research_only');
  assert.ok(scope.toolScope instanceof Set);
  assert.ok(scope.toolScope.has('web_search'));
  assert.ok(scope.toolScope.has('web_fetch'));
  assert.equal(scope.toolScope.has('ui_forge'), false);
  assert.ok(scope.suppressedPacks.includes('web'));
  assert.ok(scope.suppressedPacks.includes('media'));
});

test('determineToolScope does not suppress web pack for explicit website construction', () => {
  const prompt = 'build a modern website landing page for my company with tailwind';
  const scope = determineToolScope(prompt);

  assert.notEqual(scope.archetype, 'web_research_only');
  assert.equal(scope.suppressedPacks.includes('web'), false);
});

test('determineToolScope classifies system administration commands', () => {
  const prompt = 'kill process on port 8080 and check port status';
  const scope = determineToolScope(prompt);

  assert.equal(scope.archetype, 'system_admin');
  assert.ok(scope.toolScope instanceof Set);
  assert.ok(scope.toolScope.has('sysRun'));
  assert.ok(scope.toolScope.has('process_list'));
});

test('filterSuppressedPacks removes suppressed packs cleanly', () => {
  const wallpaperPrompt = 'change my desktop wallpaper to a snowy mountain';
  const initialPacks = ['system', 'web', 'media', 'game'];

  const filtered = filterSuppressedPacks(initialPacks, wallpaperPrompt);

  assert.equal(filtered.has('system'), false);
  assert.equal(filtered.has('web'), false);
  assert.equal(filtered.has('media'), false);
  assert.equal(filtered.has('game'), false);
});

test('desktop tools remain available on demand after initial pack suppression', () => {
  const prompt = 'change my desktop wallpaper to a snowy mountain';
  const recommendation = determineToolScope(prompt);
  const packs = filterSuppressedPacks(['system', 'web', 'media'], prompt);
  const definitions = [
    { name: 'sysRun' },
    { name: 'tool_search' },
    { name: 'web_search' },
    { name: 'desktop_act' }
  ];
  const unlockedTools = new Set(recommendation.toolScope);

  const initial = resolveActiveTools(definitions, packs, unlockedTools, null, { residentOnly: true });
  assert.deepEqual(initial.map((tool: { name: string }) => tool.name), ['sysRun', 'tool_search', 'web_search']);

  unlockedTools.add('desktop_act');
  const discovered = resolveActiveTools(definitions, packs, unlockedTools, null, { residentOnly: true });
  assert.ok(discovered.some((tool: { name: string }) => tool.name === 'desktop_act'));
});

test('resolveLazyPlaybooks suppresses massive playbooks when tools are uninvoked', () => {
  const unlockedPacks = ['web', 'media'];
  const observedTools: string[] = [];
  const prompt = 'find wallpaper and set desktop image';

  const result = resolveLazyPlaybooks(unlockedPacks, observedTools, prompt);

  // Full playbooks should be empty because neither web nor media tools were called
  assert.equal(result.fullPlaybooks, '');
  assert.ok(result.microAnnouncements.includes('web:'));
  assert.ok(result.microAnnouncements.includes('media:'));
  assert.ok(result.tokenSavingsEstimate > 2000);
});

test('resolveLazyPlaybooks expands domain playbook when a domain tool is invoked', () => {
  const unlockedPacks = ['web', 'media'];
  const observedTools = ['ui_forge'];
  const prompt = 'build a sleek dashboard';

  const result = resolveLazyPlaybooks(unlockedPacks, observedTools, prompt);

  // Web playbook should now be expanded in fullPlaybooks
  assert.ok(result.fullPlaybooks.includes('FRONTEND ENGINEERING MANDATE'));
  assert.equal(result.activePlaybookDomains.includes('web'), true);

  // Media playbook should still remain in microAnnouncements
  assert.equal(result.activePlaybookDomains.includes('media'), false);
  assert.ok(result.microAnnouncements.includes('media:'));
});

test('resolveLazyPlaybooks expands media playbook when 3D Blender tool is invoked', () => {
  const unlockedPacks = ['media'];
  const observedTools = ['blender_act'];
  const prompt = 'render a 3d model';

  const result = resolveLazyPlaybooks(unlockedPacks, observedTools, prompt);

  assert.ok(result.fullPlaybooks.includes('Media Generation Protocol'));
  assert.equal(result.activePlaybookDomains.includes('media'), true);
});
