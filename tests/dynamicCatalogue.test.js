import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  normalizeProviderKey,
  getCuratedModels,
  readModelCache,
  writeModelCache,
  getCachedModels,
  saveCachedModels,
  resolveAvailableModels,
  getAvailableProvidersOverview,
  discoverAntigravityModels,
  discoverPeerModels
} from '../src/dynamicCatalogue.js';
import {
  parseAgyModelsOutput,
  resolveAgyModelId,
  registerAntigravityModel,
  ANTIGRAVITY_MODEL_IDS
} from '../src/providers/antigravity.js';
import { runCommand } from '../src/commands.js';
import { loadConfig, saveConfig } from '../src/config.js';

test('dynamic catalogue: provider normalization maps common aliases', () => {
  assert.equal(normalizeProviderKey('Alibaba'), 'dashscope-byok');
  assert.equal(normalizeProviderKey('dashscope'), 'dashscope-byok');
  assert.equal(normalizeProviderKey('dashscope-byok'), 'dashscope-byok');
  assert.equal(normalizeProviderKey('Claude'), 'anthropic');
  assert.equal(normalizeProviderKey('Google'), 'gemini');
  assert.equal(normalizeProviderKey('Grok'), 'xai');
  assert.equal(normalizeProviderKey('Kimi'), 'moonshot');
  assert.equal(normalizeProviderKey('Custom'), 'openai-compatible');
  assert.equal(normalizeProviderKey('Ollama'), 'ollama');
});

test('dynamic catalogue: curated models return expected catalogue entries', () => {
  const gemini = getCuratedModels('gemini');
  assert.ok(gemini.includes('gemini-2.5-pro'));
  assert.ok(gemini.includes('gemini-2.5-flash'));

  const anthropic = getCuratedModels('anthropic');
  assert.ok(anthropic.includes('claude-3-7-sonnet'));

  const openai = getCuratedModels('openai');
  assert.ok(openai.includes('gpt-4o'));
});

test('dynamic catalogue: cache read/write roundtrip is safe and non-throwing', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-dyn-test-'));
  const originalHome = process.env.CAUSYNE_HOME;
  try {
    process.env.CAUSYNE_HOME = tempDir;
    saveCachedModels('ollama', ['test-custom-1', 'test-custom-2']);

    const cached = getCachedModels('ollama');
    assert.deepEqual(cached, ['test-custom-1', 'test-custom-2']);
  } finally {
    if (originalHome) process.env.CAUSYNE_HOME = originalHome;
    else delete process.env.CAUSYNE_HOME;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('dynamic catalogue: resolveAvailableModels falls back to catalogue without credentials', async () => {
  const result = await resolveAvailableModels('anthropic', {});
  assert.equal(result.source, 'catalogue');
  assert.ok(result.models.includes('claude-3-7-sonnet'));
});

test('slash command: /model and /models list available models', async () => {
  const listResult = await runCommand('model', ['list', 'gemini'], { surface: 'terminal' });
  assert.ok(listResult.ok);
  assert.ok(listResult.output.includes('Available models for gemini'));
  assert.ok(listResult.output.includes('gemini-2.5-pro'));

  const aliasResult = await runCommand('models', ['list', 'openai'], { surface: 'terminal' });
  assert.ok(aliasResult.ok);
  assert.ok(aliasResult.output.includes('Available models for openai'));
  assert.ok(aliasResult.output.includes('gpt-4o'));
});

test('dynamic catalogue: getAvailableProvidersOverview separates BYOK and ACP with live auto-detection', () => {
  const overview = getAvailableProvidersOverview({ provider: 'antigravity', model: 'Gemini 3.8 Flash (Low)' });
  assert.equal(overview.activeProvider, 'antigravity');
  assert.ok(Array.isArray(overview.byok));
  assert.ok(Array.isArray(overview.acp));

  const byokIds = overview.byok.map(p => p.id);
  assert.ok(byokIds.includes('anthropic'));
  assert.ok(byokIds.includes('openai'));
  assert.ok(byokIds.includes('gemini'));
  assert.ok(byokIds.includes('deepseek'));

  const acpIds = overview.acp.map(p => p.id);
  assert.ok(acpIds.includes('antigravity'));
  assert.ok(acpIds.includes('opencode'));
  assert.ok(acpIds.includes('claude'));
  assert.ok(acpIds.includes('codex'));

  const codex = overview.acp.find(p => p.id === 'codex');
  assert.ok(codex);
  assert.equal(codex.installed, false);
  assert.equal(codex.status, 'not_installed');
});

test('slash command: /model displays separated BYOK and ACP overview', async () => {
  const result = await runCommand('model', [], { surface: 'terminal' });
  assert.ok(result.ok);
  assert.ok(result.output.includes('BYOK PROVIDERS'));
  assert.ok(result.output.includes('ACP PEER AGENTS'));

  const listAll = await runCommand('model', ['list'], { surface: 'terminal' });
  assert.ok(listAll.ok);
  assert.ok(listAll.output.includes('BYOK PROVIDERS (Cloud APIs & Local Endpoints)'));
  assert.ok(listAll.output.includes('ACP PEER AGENTS (Local Agents & CLI Engines)'));
  assert.ok(listAll.output.includes('Google Antigravity (AGY)'));
  assert.ok(listAll.output.includes('OpenCode'));
  assert.ok(listAll.output.includes('NOT INSTALLED'));
});

test('slash command: /model acp/<peer> warns when CLI is not installed and preserves config', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-cmd-test-'));
  const originalHome = process.env.CAUSYNE_HOME;
  try {
    process.env.CAUSYNE_HOME = tempDir;
    const initialConfig = { provider: 'antigravity', model: 'Gemini 3.8 Flash (High)' };
    saveConfig(initialConfig);

    const result = await runCommand('model', ['acp/codex'], { surface: 'terminal' });
    assert.ok(result.output.includes('Notice: "Codex CLI" CLI is not installed on this machine'));
    assert.ok(result.output.includes('Binary "codex" was not found on PATH'));
    assert.ok(result.output.includes('Model was not changed'));

    const currentConfig = loadConfig();
    assert.equal(currentConfig.provider, 'antigravity');
    assert.equal(currentConfig.model, 'Gemini 3.8 Flash (High)');
  } finally {
    if (originalHome) process.env.CAUSYNE_HOME = originalHome;
    else delete process.env.CAUSYNE_HOME;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('antigravity: parseAgyModelsOutput parses tabs, spaces, and handles spinners', () => {
  const stdout = [
    '⠋ Fetching available models...',
    '⠙ Fetching available models...',
    'gemini-4-argon-medium\tGemini 4 Argon (Medium)',
    'gemini-3.8-flash-high   Gemini 3.8 Flash (High)',
    'claude-opus-5-5-high\tClaude Opus 5.5 (High)',
    'new-frontier-model      New Frontier Model (Max)'
  ].join('\n');

  const parsed = parseAgyModelsOutput(stdout);
  assert.equal(parsed.length, 4);
  assert.equal(parsed[0].id, 'gemini-4-argon-medium');
  assert.equal(parsed[0].label, 'Gemini 4 Argon (Medium)');
  assert.equal(parsed[1].id, 'gemini-3.8-flash-high');
  assert.equal(parsed[1].label, 'Gemini 3.8 Flash (High)');
  assert.equal(parsed[2].id, 'claude-opus-5-5-high');
  assert.equal(parsed[2].label, 'Claude Opus 5.5 (High)');
  assert.equal(parsed[3].id, 'new-frontier-model');
  assert.equal(parsed[3].label, 'New Frontier Model (Max)');

  assert.equal(resolveAgyModelId('New Frontier Model (Max)'), 'new-frontier-model');
  assert.equal(resolveAgyModelId('new-frontier-model'), 'new-frontier-model');
});

test('antigravity: resolveAgyModelId allows unlisted slug pass-through and fuzzy effort', () => {
  assert.equal(resolveAgyModelId('unlisted-future-model-1'), 'unlisted-future-model-1');
  assert.equal(resolveAgyModelId('Gemini 4 Argon (High)'), 'gemini-4-argon-high');
  assert.equal(resolveAgyModelId('gemini-4-argon-high'), 'gemini-4-argon-high');
  assert.equal(resolveAgyModelId(''), '');
});

test('dynamic catalogue: discoverAntigravityModels returns live or fallback models', async () => {
  const models = await discoverAntigravityModels();
  assert.ok(Array.isArray(models));
  assert.ok(models.length > 0);
  assert.ok(models.some(m => m.includes('Gemini') || m.includes('Claude') || m.includes('Argon')));
});

test('dynamic catalogue: discoverPeerModels autodetects opencode and claude', async () => {
  const opencode = await discoverPeerModels('opencode');
  assert.ok(Array.isArray(opencode));
  assert.ok(opencode.length > 0);

  const claude = await discoverPeerModels('claude');
  assert.ok(Array.isArray(claude));
  assert.ok(claude.includes('sonnet'));
  assert.ok(claude.includes('opus'));
  assert.ok(claude.includes('haiku'));

  const unknown = await discoverPeerModels('non-existent-peer');
  assert.deepEqual(unknown, []);
});

