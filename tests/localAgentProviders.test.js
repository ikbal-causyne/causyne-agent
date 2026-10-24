// Local agents as first-class providers.
//
// The promise this file protects: a CLI the user has already logged into
// (OpenCode, Claude Code, Codex, Antigravity, Cursor, …) behaves like an API
// provider — selectable by name, with its own model list, its own default, and
// a cost of zero because the user already pays for it elsewhere.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  normalizeProviderKey, peerIdFromProviderKey, getCuratedModels
} from '../src/dynamicCatalogue.js';
import { AcpProvider } from '../src/providers/acp.js';
import { AntigravityProvider, resolveAgyModelId, ANTIGRAVITY_MODELS } from '../src/providers/antigravity.js';
import { createProvider } from '../src/providers/factory.js';
import { TokenTracker } from '../src/tokenTracker.js';
import { runCommand } from '../src/commands.js';
import { loadConfig, saveConfig } from '../src/config.js';

const PEER_KEYS = [
  'acp/opencode', 'acp/claude', 'acp/codex', 'acp/gemini', 'acp/cursor',
  'acp/qwen', 'acp/copilot', 'acp/kimi', 'acp/goose', 'acp/hermes'
];

describe('peer agents as first-class providers', () => {
  test('provider keys keep the peer and normalize', () => {
    assert.equal(normalizeProviderKey('acp/opencode'), 'acp/opencode');
    assert.equal(normalizeProviderKey('ACP/Codex'), 'acp/codex');
    assert.equal(normalizeProviderKey('agy'), 'antigravity');
    assert.equal(peerIdFromProviderKey('acp/opencode'), 'opencode');
    assert.equal(peerIdFromProviderKey('acp/claude'), 'claude');
    assert.equal(peerIdFromProviderKey('acp'), null);
    assert.equal(peerIdFromProviderKey('openai'), null);
  });

  test('the catalogue exposes what each peer actually publishes', () => {
    assert.ok(getCuratedModels('acp/opencode').includes('opencode/beam-free'));
    assert.deepEqual(getCuratedModels('acp/claude'), ['sonnet', 'opus', 'haiku']);
    assert.ok(getCuratedModels('antigravity').includes('Gemini 4 Argon (High)'));
    assert.ok(getCuratedModels('acp').includes('opencode'));
  });

  test('AcpProvider resolves the peer and that peer\'s own default', () => {
    const opencode = new AcpProvider({ provider: 'acp/opencode' });
    assert.equal(opencode.peerId, 'opencode');
    assert.equal(opencode.model, 'opencode/beam-free');

    const claude = new AcpProvider({ provider: 'acp/claude' });
    assert.equal(claude.peerId, 'claude');
    assert.equal(claude.model, 'sonnet');

    // Legacy shape: `provider: acp` carried the peer in the model field.
    const legacy = new AcpProvider({ provider: 'acp', model: 'codex' });
    assert.equal(legacy.peerId, 'codex');
    assert.equal(legacy.model, 'codex');
  });

  test('createProvider routes every advertised peer key to an adapter', () => {
    for (const id of PEER_KEYS) {
      const provider = createProvider({ provider: id, model: '' });
      assert.equal(provider.peerId, id.slice(4), id);
    }
    assert.ok(createProvider({ provider: 'antigravity' }) instanceof AntigravityProvider);
  });

  test('Antigravity labels resolve to the ids agy actually accepts', () => {
    assert.equal(resolveAgyModelId('Gemini 3.8 Flash (Low)'), 'gemini-3.8-flash-low');
    assert.equal(resolveAgyModelId('Claude Opus 5.5 (High)'), 'claude-opus-5-5-high');
    assert.equal(resolveAgyModelId('gemini-4-argon-medium'), 'gemini-4-argon-medium');
    for (const label of ANTIGRAVITY_MODELS) {
      assert.match(resolveAgyModelId(label), /^[a-z0-9.-]+$/, label);
    }
  });

  test('ACP forwards images only when the peer advertises them', () => {
    const provider = new AcpProvider({ provider: 'acp/opencode' });
    const messages = [{
      role: 'user',
      content: [
        { type: 'text', text: 'What is this?' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }
      ]
    }];

    const seen = provider.formatPromptBlocks(messages, [], true);
    assert.ok(seen.some((block) => block.type === 'image' && block.mimeType === 'image/png'));

    const blind = provider.formatPromptBlocks(messages, [], false);
    assert.ok(!blind.some((block) => block.type === 'image'));
    assert.ok(blind.some((block) => block.type === 'text' && block.text.includes('does not accept image input')));
  });

  test('peer sessions cost $0 — the user already pays their own subscription', () => {
    const tracker = (provider, model) => {
      const t = new TokenTracker();
      t.config = { ...t.config, provider, model };
      return t;
    };
    assert.deepEqual(tracker('acp/opencode', 'opencode/beam-free').getPricing(), [0, 0]);
    assert.deepEqual(tracker('acp/claude', 'sonnet').getPricing(), [0, 0]);
    assert.deepEqual(tracker('acp', 'opencode').getPricing(), [0, 0]);
    assert.deepEqual(tracker('antigravity', 'Gemini 3.8 Flash (Low)').getPricing(), [0, 0]);
  });
});

describe('/model understands peer provider keys', () => {
  let tempDir;
  let originalHome;
  let fakeBinDir;
  let originalPath;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-peer-test-'));
    originalHome = process.env.CAUSYNE_HOME;
    process.env.CAUSYNE_HOME = tempDir;

    fakeBinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-peer-bin-'));
    const binName = process.platform === 'win32' ? 'opencode.cmd' : 'opencode';
    const fakeBin = path.join(fakeBinDir, binName);
    fs.writeFileSync(fakeBin, process.platform === 'win32' ? '@exit /b 0' : '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    originalPath = process.env.PATH;
    process.env.PATH = `${fakeBinDir}${path.delimiter}${process.env.PATH || ''}`;
  });

  after(() => {
    if (originalHome) process.env.CAUSYNE_HOME = originalHome;
    else delete process.env.CAUSYNE_HOME;
    if (originalPath) process.env.PATH = originalPath;
    if (fakeBinDir) fs.rmSync(fakeBinDir, { recursive: true, force: true });
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  const reset = (provider = '', model = '') => {
    const config = loadConfig();
    config.provider = provider;
    config.model = model;
    config.apiKey = '';
    saveConfig(config);
  };

  test('acp/<peer> selects the provider and its default model', async () => {
    reset();
    const result = await runCommand('model', ['acp/opencode'], { surface: 'terminal' });
    assert.ok(result.ok);
    const saved = loadConfig();
    assert.equal(saved.provider, 'acp/opencode');
    assert.equal(saved.model, 'opencode/beam-free');
  });

  test('acp/<peer>/<model> sets both', async () => {
    reset();
    await runCommand('model', ['acp/opencode/opencode/flint-40b-free'], { surface: 'terminal' });
    const saved = loadConfig();
    assert.equal(saved.provider, 'acp/opencode');
    assert.equal(saved.model, 'opencode/flint-40b-free');
  });

  test('a namespaced peer model id is not mistaken for a provider', async () => {
    reset('acp/opencode', 'opencode/beam-free');
    await runCommand('model', ['opencode/deepseek-v4.1-flash-free'], { surface: 'terminal' });
    const saved = loadConfig();
    assert.equal(saved.provider, 'acp/opencode');
    assert.equal(saved.model, 'opencode/deepseek-v4.1-flash-free');
  });
});
