import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { extractAcpSessionModels } from '../src/acp/protocol.js';
import { testPeerHandshake } from '../src/acp/agentCatalog.js';
import { AcpProvider } from '../src/providers/acp.js';
import {
  BASELINE_ANTIGRAVITY_MODELS,
  ANTIGRAVITY_MODELS,
  parseAgyModelsOutput,
  replaceAntigravityModels,
  resolveAgyModelId,
  synthesizeAgySlug
} from '../src/providers/antigravity.js';
import {
  computeProviderAuthFingerprint,
  detectPeerConfigModels,
  getAvailableProvidersOverview,
  getCachedModels,
  parseModelIds,
  parsePiModelsOutput,
  pickDefaultPeerModel,
  resolveAvailableModels,
  saveCachedModels
} from '../src/dynamicCatalogue.js';

describe('Enterprise Dynamic ACP & CLI Model Auto-Detection', () => {
  test('extractAcpSessionModels extracts flat and grouped configOptions and models payloads', () => {
    const configOptionsPayload = {
      sessionId: 'ses_123',
      configOptions: [
        {
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: 'anthropic/claude-opus-6',
          options: [
            { value: 'anthropic/claude-opus-6', name: 'Claude Opus 6 (Ultra Tier)' },
            {
              group: 'OpenAI',
              options: [
                { value: 'openai/gpt-6-pro', name: 'GPT-6 Pro' },
                { value: 'openai/gpt-6-mini', name: 'GPT-6 Mini' }
              ]
            }
          ]
        }
      ]
    };

    const extracted = extractAcpSessionModels(configOptionsPayload);
    assert.equal(extracted.currentModelId, 'anthropic/claude-opus-6');
    assert.equal(extracted.usesConfigOption, true);
    assert.equal(extracted.configOptionId, 'model');
    assert.deepEqual(extracted.availableModels, [
      'anthropic/claude-opus-6',
      'openai/gpt-6-pro',
      'openai/gpt-6-mini'
    ]);
    assert.equal(extracted.modelLabels['anthropic/claude-opus-6'], 'Claude Opus 6 (Ultra Tier)');
    assert.equal(extracted.modelLabels['openai/gpt-6-pro'], 'GPT-6 Pro');

    const legacyModelsPayload = {
      sessionId: 'ses_456',
      models: {
        currentModelId: 'gemini-4-ultra',
        availableModels: [
          { modelId: 'gemini-4-ultra', name: 'Gemini 4 Ultra' },
          { id: 'gemini-4-flash', name: 'Gemini 4 Flash' }
        ]
      }
    };
    const extractedLegacy = extractAcpSessionModels(legacyModelsPayload);
    assert.equal(extractedLegacy.currentModelId, 'gemini-4-ultra');
    assert.equal(extractedLegacy.usesConfigOption, false);
    assert.deepEqual(extractedLegacy.availableModels, ['gemini-4-ultra', 'gemini-4-flash']);
  });

  test('account/tier switch invalidates cached models immediately via auth fingerprint', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-tier-switch-'));
    const prevCausyneHome = process.env.CAUSYNE_HOME;
    const prevHome = process.env.HOME;

    try {
      process.env.CAUSYNE_HOME = path.join(tempDir, '.causyne');
      process.env.HOME = tempDir;

      const claudeDir = path.join(tempDir, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      const settingsFile = path.join(claudeDir, 'settings.json');

      // 1. User starts on Starter tier account
      fs.writeFileSync(settingsFile, JSON.stringify({ model: 'claude-haiku-starter' }));
      const fpStarter = computeProviderAuthFingerprint('acp/claude');
      saveCachedModels('acp/claude', ['claude-haiku-starter']);
      assert.deepEqual(getCachedModels('acp/claude'), ['claude-haiku-starter']);

      // 2. User upgrades account to Ultra tier (settings/auth file changes)
      const futureTime = Date.now() + 5000;
      fs.writeFileSync(
        settingsFile,
        JSON.stringify({
          model: 'claude-opus-6-ultra',
          availableModels: ['claude-opus-6-ultra', 'claude-sonnet-6-pro']
        })
      );
      fs.utimesSync(settingsFile, futureTime / 1000, futureTime / 1000);

      const fpUltra = computeProviderAuthFingerprint('acp/claude');
      assert.notEqual(fpStarter, fpUltra, 'Account fingerprint must change when user auth/settings change');

      // Cache must be immediately invalidated despite 15m TTL not having elapsed
      assert.equal(
        getCachedModels('acp/claude'),
        null,
        'Stale Starter tier cache must be invalidated immediately upon Ultra tier switch'
      );

      // Overview immediately picks up the new config models
      const overview = getAvailableProvidersOverview({ provider: 'acp/claude' });
      const claudePeer = overview.acp.find((p) => p.id === 'claude');
      assert.ok(claudePeer);
      assert.ok(claudePeer.models.includes('claude-opus-6-ultra'));
      assert.ok(claudePeer.models.includes('claude-sonnet-6-pro'));
    } finally {
      if (prevCausyneHome === undefined) delete process.env.CAUSYNE_HOME;
      else process.env.CAUSYNE_HOME = prevCausyneHome;
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('live ACP peer models replace static catalogue without keeping retired models', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-live-replace-'));
    const prevCausyneHome = process.env.CAUSYNE_HOME;
    try {
      process.env.CAUSYNE_HOME = tempDir;
      // Simulate live discovery saving a new generation of OpenCode models where old ones were retired
      saveCachedModels('acp/opencode', ['opencode/nova-v5-free', 'opencode/quantum-coder-free']);

      const resolved = await resolveAvailableModels('acp/opencode', {}, false);
      assert.equal(resolved.source, 'cache');
      assert.deepEqual(resolved.models, ['opencode/nova-v5-free', 'opencode/quantum-coder-free']);
      assert.ok(
        !resolved.models.includes('opencode/big-pickle'),
        'Retired baseline models must not pollute live/cached peer model list'
      );

      // pickDefaultPeerModel selects the first live model when static default was retired
      assert.equal(
        pickDefaultPeerModel('acp/opencode', resolved.models),
        'opencode/nova-v5-free'
      );
    } finally {
      if (prevCausyneHome === undefined) delete process.env.CAUSYNE_HOME;
      else process.env.CAUSYNE_HOME = prevCausyneHome;
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('Antigravity replaces active model list per account tier and synthesizes slugs for unseen models', () => {
    const originalModels = [...ANTIGRAVITY_MODELS];
    try {
      const ultraStdout = [
        'Fetching available models...',
        'gemini-4.5-ultra-max\tGemini 4.5 Ultra (Max)',
        'claude-opus-6-0-high\tClaude Opus 6.0 (High)'
      ].join('\n');

      const parsed = parseAgyModelsOutput(ultraStdout, { replaceActiveList: true });
      assert.equal(parsed.length, 2);
      assert.deepEqual(ANTIGRAVITY_MODELS, [
        'Gemini 4.5 Ultra (Max)',
        'Claude Opus 6.0 (High)'
      ]);
      assert.equal(resolveAgyModelId('Gemini 4.5 Ultra (Max)'), 'gemini-4.5-ultra-max');
      assert.equal(resolveAgyModelId('Claude Opus 6.0 (High)'), 'claude-opus-6-0-high');

      // Synthesize slugs for future unseen display names even before `agy models` runs
      assert.equal(synthesizeAgySlug('Gemini 5.2 Hyper (High)'), 'gemini-5.2-hyper-high');
      assert.equal(synthesizeAgySlug('Claude Sonnet 6.5 (Medium)'), 'claude-sonnet-6-5-medium');
      assert.equal(resolveAgyModelId('Claude Sonnet 6.5 (Medium)'), 'claude-sonnet-6-5-medium');
    } finally {
      replaceAntigravityModels(
        Object.entries(BASELINE_ANTIGRAVITY_MODELS).map(([label, id]) => ({ id, label }))
      );
      if (originalModels.length > 0) {
        replaceAntigravityModels(originalModels);
      }
    }
  });

  test('parsePiModelsOutput and parseModelIds extract valid models and reject paths/prose', () => {
    const piHelpOutput = [
      'No models available. Use /login to log into a provider via OAuth or API key. See:',
      '  ~/node_modules/@earendil-works/pi-coding-agent/docs/providers.md',
      '  ~/node_modules/@earendil-works/pi-coding-agent/docs/models.md'
    ].join('\n');
    assert.deepEqual(parsePiModelsOutput(piHelpOutput), []);
    assert.deepEqual(parseModelIds(piHelpOutput.split('\n')), []);

    const piTableOutput = [
      'provider   model                      context  max-out  thinking  images',
      'anthropic  claude-sonnet-4-5          200K     8K       yes       yes',
      'openai     gpt-5.4-codex              400K     32K      yes       yes'
    ].join('\n');
    assert.deepEqual(parsePiModelsOutput(piTableOutput), [
      'anthropic/claude-sonnet-4-5',
      'openai/gpt-5.4-codex'
    ]);
  });

  test('detectPeerConfigModels reads codex, gemini, opencode, and pi local configs', () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-peer-cfg-'));
    const prevHome = process.env.HOME;
    try {
      process.env.HOME = tempHome;

      fs.mkdirSync(path.join(tempHome, '.codex'), { recursive: true });
      fs.writeFileSync(path.join(tempHome, '.codex', 'config.toml'), 'model = "gpt-5.5-codex-ultra"\n');

      fs.mkdirSync(path.join(tempHome, '.gemini'), { recursive: true });
      fs.writeFileSync(
        path.join(tempHome, '.gemini', 'settings.json'),
        JSON.stringify({ selectedModel: 'gemini-3.5-pro-ultra', availableModels: ['gemini-3.5-pro-ultra', 'gemini-3.5-flash'] })
      );

      fs.mkdirSync(path.join(tempHome, '.pi', 'agent'), { recursive: true });
      fs.writeFileSync(
        path.join(tempHome, '.pi', 'agent', 'settings.json'),
        JSON.stringify({ defaultProvider: 'anthropic', defaultModel: 'claude-opus-5' })
      );

      assert.deepEqual(detectPeerConfigModels('codex'), ['gpt-5.5-codex-ultra']);
      assert.deepEqual(detectPeerConfigModels('gemini'), ['gemini-3.5-pro-ultra', 'gemini-3.5-flash']);
      assert.deepEqual(detectPeerConfigModels('pi'), ['anthropic/claude-opus-5']);
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  test('AcpClient and AcpProvider auto-detect live models over ACP session/new and fallback when default model is retired', { skip: process.platform === 'win32' }, async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-acp-mock-'));
    const mockPeerScript = path.join(tempDir, 'mock-acp-peer.js');
    fs.writeFileSync(
      mockPeerScript,
      `#!/usr/bin/env node
let buffer = '';
let currentModel = 'opencode/ultra-reasoner-v2';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.method === 'initialize') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          protocolVersion: 1,
          agentCapabilities: { promptCapabilities: { image: true } },
          agentInfo: { name: 'MockOpenCode', version: '2.0.0' }
        }
      }) + '\\n');
    } else if (msg.method === 'session/new') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          sessionId: 'ses_live_ultra',
          configOptions: [
            {
              id: 'model',
              name: 'Model',
              category: 'model',
              type: 'select',
              currentValue: currentModel,
              options: [
                { value: 'opencode/ultra-reasoner-v2', name: 'Ultra Reasoner V2' },
                { value: 'anthropic/claude-sonnet-6', name: 'Claude Sonnet 6' }
              ]
            }
          ]
        }
      }) + '\\n');
    } else if (msg.method === 'session/set_model') {
      // Simulate peer that only supports session/set_config_option or rejects retired models
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        error: { code: -32601, message: 'Method not found: use session/set_config_option' }
      }) + '\\n');
    } else if (msg.method === 'session/set_config_option') {
      currentModel = msg.params.value;
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: {
          configOptions: [
            {
              id: 'model',
              category: 'model',
              currentValue: currentModel,
              options: [
                { value: 'opencode/ultra-reasoner-v2', name: 'Ultra Reasoner V2' },
                { value: 'anthropic/claude-sonnet-6', name: 'Claude Sonnet 6' }
              ]
            }
          ]
        }
      }) + '\\n');
    } else if (msg.method === 'session/prompt') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'ses_live_ultra',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Active model: ' + currentModel }
          }
        }
      }) + '\\n');
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: msg.id,
        result: { stopReason: 'end_turn' }
      }) + '\\n');
    }
  }
});
`,
      { mode: 0o755 }
    );

    try {
      const handshake = await testPeerHandshake({
        command: process.execPath,
        args: [mockPeerScript],
        timeoutMs: 5000
      });
      assert.equal(handshake.ready, true);
      assert.equal(handshake.currentModelId, 'opencode/ultra-reasoner-v2');
      assert.deepEqual(handshake.availableModels, [
        'opencode/ultra-reasoner-v2',
        'anthropic/claude-sonnet-6'
      ]);

      // AcpProvider initialized with default (which resolves to opencode/beam-free when unconfigured)
      // must automatically detect that opencode/beam-free is not in the peer's live models and switch
      // to opencode/ultra-reasoner-v2 via session/set_config_option!
      const provider = new AcpProvider({
        provider: 'acp/opencode',
        command: process.execPath,
        args: [mockPeerScript]
      });
      try {
        const res = await provider.chat([{ role: 'user', content: 'which model?' }]);
        assert.equal(provider.model, 'opencode/ultra-reasoner-v2');
        assert.equal(res.content, 'Active model: opencode/ultra-reasoner-v2');
      } finally {
        await provider.close();
      }

      // Also verify non-opencode-prefixed provider model in OpenCode (e.g. anthropic/claude-sonnet-6)
      // is NOT corrupted into opencode/anthropic/claude-sonnet-6
      const providerCustom = new AcpProvider({
        provider: 'acp/opencode',
        model: 'anthropic/claude-sonnet-6',
        command: process.execPath,
        args: [mockPeerScript]
      });
      try {
        const res2 = await providerCustom.chat([{ role: 'user', content: 'which model?' }]);
        assert.equal(providerCustom.model, 'anthropic/claude-sonnet-6');
        assert.equal(res2.content, 'Active model: anthropic/claude-sonnet-6');
      } finally {
        await providerCustom.close();
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
