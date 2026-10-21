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
  resolveAvailableModels
} from '../src/dynamicCatalogue.js';
import { runCommand } from '../src/commands.js';

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
