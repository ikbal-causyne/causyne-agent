import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  resolveModelVariants,
  matchVariantOption,
  normalizeVariantToken
} from '../src/modelVariants.js';
import { extractAcpSessionVariants, normalizeAcpMcpServers } from '../src/acp/protocol.js';
import { parseOpenCodeVerboseModels, saveCachedModels, getModelVariantsForPeer } from '../src/dynamicCatalogue.js';
import { suggest } from '../src/tui/completion.js';
import { runCommand, resolveCommand } from '../src/commands.js';
import { loadConfig, saveConfig } from '../src/config.js';

test('resolveModelVariants dynamically adapts to BYOK, Free, Ollama, Antigravity, and ACP live peers', () => {
  // 1. OpenAI GPT-5.4 exposes xhigh; GPT-4o exposes none
  const gpt54 = resolveModelVariants({ provider: 'openai', model: 'gpt-5.4' });
  assert.equal(gpt54.supported, true);
  assert.deepEqual(gpt54.options.map((o) => o.id), ['none', 'low', 'medium', 'high', 'xhigh']);

  const gpt4o = resolveModelVariants({ provider: 'openai', model: 'gpt-4o' });
  assert.equal(gpt4o.supported, false);
  assert.equal(gpt4o.options.length, 0);

  // 2. Anthropic Claude Opus 4.7 exposes xhigh + max; Sonnet 4.6 exposes off..high; Haiku exposes none
  const opus47 = resolveModelVariants({ provider: 'anthropic', model: 'claude-opus-4-7' });
  assert.equal(opus47.supported, true);
  assert.deepEqual(opus47.options.map((o) => o.id), ['off', 'low', 'medium', 'high', 'xhigh', 'max']);

  const sonnet46 = resolveModelVariants({ provider: 'anthropic', model: 'claude-sonnet-4-6' });
  assert.equal(sonnet46.supported, true);
  assert.deepEqual(sonnet46.options.map((o) => o.id), ['off', 'low', 'medium', 'high']);

  const haiku = resolveModelVariants({ provider: 'anthropic', model: 'claude-3-5-haiku' });
  assert.equal(haiku.supported, false);

  // 3. Gemini 3 Flash vs Gemini 2.5 Pro vs Gemini 2.0 Flash
  const gem3 = resolveModelVariants({ provider: 'gemini', model: 'gemini-3-flash-preview' });
  assert.deepEqual(gem3.options.map((o) => o.id), ['minimal', 'low', 'medium', 'high']);

  const gem25 = resolveModelVariants({ provider: 'gemini-free', model: 'gemini-2.5-pro' });
  assert.deepEqual(gem25.options.map((o) => o.id), ['low', 'medium', 'high']);

  const gem20 = resolveModelVariants({ provider: 'gemini', model: 'gemini-2.0-flash' });
  assert.equal(gem20.supported, false);

  // 4. xAI Grok reasoning vs non-reasoning
  const grokReason = resolveModelVariants({ provider: 'xai', model: 'grok-420-reasoning' });
  assert.deepEqual(grokReason.options.map((o) => o.id), ['low', 'medium', 'high', 'xhigh']);

  const grokMini = resolveModelVariants({ provider: 'xai', model: 'grok-3-mini' });
  assert.deepEqual(grokMini.options.map((o) => o.id), ['low', 'high']);

  // 5. OpenRouter Free meta-router & Qwen3
  const orFree = resolveModelVariants({ provider: 'openrouter-free', model: 'openrouter/free' });
  assert.equal(orFree.supported, true);
  assert.deepEqual(orFree.options.map((o) => o.id), ['off', 'low', 'medium', 'high']);

  const qwen3 = resolveModelVariants({ provider: 'qwen', model: 'qwen3-max' });
  assert.deepEqual(qwen3.options.map((o) => o.id), ['off', 'low', 'medium', 'high']);

  // 6. Local Ollama capabilities (live /api/show + gpt-oss vs non-thinking llama3.2)
  const ollamaGptOss = resolveModelVariants({ provider: 'ollama', model: 'gpt-oss:20b' });
  assert.equal(ollamaGptOss.source, 'ollama_live');
  assert.deepEqual(ollamaGptOss.options.map((o) => o.id), ['low', 'medium', 'high']);

  const ollamaQwen3 = resolveModelVariants({ provider: 'ollama', model: 'qwen3:8b', ollamaSupportsThinking: true });
  assert.deepEqual(ollamaQwen3.options.map((o) => o.id), ['off', 'on']);

  const ollamaLlama = resolveModelVariants({ provider: 'ollama', model: 'llama3.2:latest', ollamaSupportsThinking: false });
  assert.equal(ollamaLlama.supported, false);

  // 7. Antigravity dynamic sibling model discovery (including custom ultra tier if exposed)
  const agy = resolveModelVariants({
    provider: 'antigravity',
    model: 'Gemini 3.8 Pro (Low)',
    availableAgyModels: [
      'Gemini 3.8 Pro (Low)',
      'Gemini 3.8 Pro (Medium)',
      'Gemini 3.8 Pro (High)',
      'Gemini 3.8 Pro (Ultra)',
      'Claude Sonnet 4.6 (Thinking)'
    ]
  });
  assert.equal(agy.source, 'agy_models');
  assert.deepEqual(agy.options.map((o) => o.id), ['low', 'medium', 'high', 'ultra']);
  assert.equal(agy.options[3].targetModelId, 'Gemini 3.8 Pro (Ultra)');

  // 8. Live ACP configOptions take highest authority (supports arbitrary peer variants like ultra)
  const liveAcp = extractAcpSessionVariants({
    configOptions: [
      {
        id: 'thought_level',
        category: 'thought_level',
        name: 'Reasoning Effort',
        currentValue: 'high',
        options: [
          { value: 'low', name: 'Low' },
          { value: 'medium', name: 'Medium' },
          { value: 'high', name: 'High' },
          { value: 'xhigh', name: 'Extra High' },
          { value: 'ultra', name: 'Ultra' }
        ]
      }
    ]
  });
  assert.ok(liveAcp);
  assert.equal(liveAcp.configOptionId, 'thought_level');
  assert.equal(liveAcp.currentValue, 'high');

  const acpSpec = resolveModelVariants({
    provider: 'acp/codex',
    model: 'gpt-5.4',
    liveAcpVariant: liveAcp
  });
  assert.equal(acpSpec.source, 'acp_live');
  assert.deepEqual(acpSpec.options.map((o) => o.id), ['low', 'medium', 'high', 'xhigh', 'ultra']);
  assert.equal(acpSpec.currentVariant, 'high');
});

test('normalizeVariantToken and matchVariantOption handle synonyms without fabricating unsupported tiers', () => {
  assert.equal(normalizeVariantToken('extra-high'), 'xhigh');
  assert.equal(normalizeVariantToken('default'), 'auto');

  const gpt54 = resolveModelVariants({ provider: 'openai', model: 'gpt-5.4' });
  assert.equal(matchVariantOption(gpt54, 'extra high')?.id, 'xhigh');
  assert.equal(matchVariantOption(gpt54, 'off')?.id, 'none');

  const o3 = resolveModelVariants({ provider: 'openai', model: 'o3' });
  assert.equal(matchVariantOption(o3, 'ultra'), null);
  assert.equal(matchVariantOption(o3, 'high')?.id, 'high');
});

test('bare slash menu ranks accelerator commands in exact developer-first order', () => {
  const { items } = suggest('/', 1);
  const top8 = items.slice(0, 8).map((item) => item.label);
  assert.deepEqual(top8, [
    '/model',
    '/variant',
    '/sessions',
    '/continuum',
    '/usage',
    '/skills',
    '/plugins',
    '/cortex'
  ]);
});

test('/variant and /cortex commands register cleanly and persist/sync live variants', async () => {
  assert.equal(resolveCommand('variant')?.name, 'variant');
  assert.equal(resolveCommand('effort')?.name, 'variant');
  assert.equal(resolveCommand('cortex')?.name, 'cortex');
  assert.equal(resolveCommand('memory')?.name, 'cortex');

  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-variant-test-'));
  const prevHome = process.env.CAUSYNE_HOME;
  process.env.CAUSYNE_HOME = tmpHome;

  try {
    // 1. Non-reasoning model rejects /variant high honestly
    saveConfig({ provider: 'openai', model: 'gpt-4o' });
    const denied = await runCommand('variant', ['high'], {});
    assert.equal(denied.ok, false);
    assert.match(denied.output || '', /does not expose tunable reasoning variants/i);

    // 2. Reasoning model accepts xhigh and saves to config
    saveConfig({ provider: 'openai', model: 'gpt-5.4' });
    let reloaded = 0;
    const setRes = await runCommand('variant', ['extra-high'], {
      loop: {
        config: loadConfig(),
        updateTierLimits() { reloaded++; }
      }
    });
    assert.equal(setRes.ok, true);
    assert.equal(loadConfig().reasoningEffort, 'xhigh');
    assert.equal(reloaded, 1);

    // 3. Reset via auto clears override
    const autoRes = await runCommand('variant', ['auto'], {
      loop: {
        config: loadConfig(),
        updateTierLimits() { reloaded++; }
      }
    });
    assert.equal(autoRes.ok, true);
    assert.equal(loadConfig().reasoningEffort, undefined);

    // 4. Live ACP session receives applyVariant without restarting peer
    saveConfig({ provider: 'acp/opencode', model: 'opencode/custom-model' });
    const appliedCalls = [];
    const acpRes = await runCommand('variant', ['ultra'], {
      loop: {
        config: loadConfig(),
        llm: {
          getLiveVariantOption() {
            return {
              configOptionId: 'thought_level',
              name: 'Effort',
              currentValue: 'medium',
              options: [
                { value: 'low', name: 'Low' },
                { value: 'medium', name: 'Medium' },
                { value: 'ultra', name: 'Ultra' }
              ]
            };
          },
          async applyVariant(value, configId) {
            appliedCalls.push({ value, configId });
            return true;
          }
        }
      }
    });
    assert.equal(acpRes.ok, true);
    assert.match(acpRes.output || '', /applied live to active ACP session/i);
    assert.deepEqual(appliedCalls, [{ value: 'ultra', configId: 'thought_level' }]);

    // 5. /cortex toggle off and on persists cleanly
    const offRes = await runCommand('cortex', ['off'], {});
    assert.equal(offRes.ok, true);
    assert.equal(loadConfig().cortex?.enabled, false);

    const onRes = await runCommand('cortex', ['on'], {});
    assert.equal(onRes.ok, true);
    assert.equal(loadConfig().cortex?.enabled, true);

    // 6. OpenCode verbose catalogue lookup resolves real variants without hallucination
    const verboseSample = [
      'opencode/beam-free',
      JSON.stringify({ id: 'beam-free', variants: { low: {}, medium: {}, high: {}, xhigh: {}, max: {} } }, null, 2),
      'opencode/deepseek-v4.1-flash-free',
      JSON.stringify({ id: 'deepseek-v4.1-flash-free', variants: { low: {}, high: {}, max: {} } }, null, 2),
      'opencode/big-pickle',
      JSON.stringify({ id: 'big-pickle', variants: {} }, null, 2)
    ].join('\n');
    const parsedVerbose = parseOpenCodeVerboseModels(verboseSample);
    assert.deepEqual(parsedVerbose.models, [
      'opencode/beam-free',
      'opencode/deepseek-v4.1-flash-free',
      'opencode/big-pickle'
    ]);
    assert.deepEqual(parsedVerbose.variantsByModel['opencode/deepseek-v4.1-flash-free'], ['low', 'high', 'max']);
    assert.deepEqual(parsedVerbose.variantsByModel['opencode/beam-free'], ['low', 'medium', 'high', 'xhigh', 'max']);
    assert.deepEqual(parsedVerbose.variantsByModel['opencode/big-pickle'], []);

    saveCachedModels('acp/opencode', parsedVerbose.models, {
      variantsByModel: parsedVerbose.variantsByModel,
      replaceVariants: true
    });
    // Preserves variantsByModel when a subsequent saveCachedModels omits variantsByModel
    saveCachedModels('acp/opencode', parsedVerbose.models, { currentModel: 'opencode/deepseek-v4.1-flash-free' });
    assert.deepEqual(getModelVariantsForPeer('acp/opencode', 'deepseek-v4.1-flash-free'), ['low', 'high', 'max']);
    assert.deepEqual(getModelVariantsForPeer('acp/opencode', 'opencode/big-pickle'), []);

    // Authoritative peer_catalogue returns exact variants for deepseek and rejects big-pickle honestly
    const ocDeepseek = resolveModelVariants({
      provider: 'acp/opencode',
      model: 'deepseek-v4.1-flash-free',
      peerModelVariants: getModelVariantsForPeer('acp/opencode', 'deepseek-v4.1-flash-free')
    });
    assert.equal(ocDeepseek.source, 'peer_catalogue');
    assert.equal(ocDeepseek.supported, true);
    assert.deepEqual(ocDeepseek.options.map((o) => o.id), ['low', 'high', 'max']);

    const ocBigPickle = resolveModelVariants({
      provider: 'acp/opencode',
      model: 'opencode/big-pickle',
      peerModelVariants: getModelVariantsForPeer('acp/opencode', 'opencode/big-pickle')
    });
    assert.equal(ocBigPickle.supported, false);
    assert.equal(ocBigPickle.options.length, 0);

    // ACP live variant strips redundant "default" choice from selectable options
    const ocLive = resolveModelVariants({
      provider: 'acp/opencode',
      model: 'opencode/deepseek-v4.1-flash-free',
      liveAcpVariant: {
        configOptionId: 'effort',
        currentValue: 'default',
        options: [
          { value: 'low', name: 'Low' },
          { value: 'high', name: 'High' },
          { value: 'max', name: 'Max' },
          { value: 'default', name: 'Default' }
        ]
      }
    });
    assert.equal(ocLive.source, 'acp_live');
    assert.deepEqual(ocLive.options.map((o) => o.id), ['low', 'high', 'max']);
    assert.equal(ocLive.currentVariant, null);

    // Antigravity Gemini 4 Neon exposes xhigh, Carbon exposes up to high, single-variant GPT-OSS is not switchable
    const agyPool = [
      'Gemini 4 Neon (Low)',
      'Gemini 4 Neon (Medium)',
      'Gemini 4 Neon (High)',
      'Gemini 4 Neon (XHigh)',
      'Gemini 4 Carbon (Low)',
      'Gemini 4 Carbon (Medium)',
      'Gemini 4 Carbon (High)',
      'GPT-OSS 120B (Medium)'
    ];
    const agyNeon = resolveModelVariants({
      provider: 'antigravity',
      model: 'Gemini 4 Neon (High)',
      availableAgyModels: agyPool
    });
    assert.equal(agyNeon.source, 'agy_models');
    assert.equal(agyNeon.supported, true);
    assert.deepEqual(agyNeon.options.map((o) => o.id), ['low', 'medium', 'high', 'xhigh']);

    const agyCarbon = resolveModelVariants({
      provider: 'antigravity',
      model: 'Gemini 4 Carbon (Medium)',
      availableAgyModels: agyPool
    });
    assert.equal(agyCarbon.supported, true);
    assert.deepEqual(agyCarbon.options.map((o) => o.id), ['low', 'medium', 'high']);

    const agyGptOss = resolveModelVariants({
      provider: 'antigravity',
      model: 'GPT-OSS 120B (Medium)',
      availableAgyModels: agyPool
    });
    assert.equal(agyGptOss.supported, false);

    // ACP MCP server normalization guarantees required env/args/headers arrays for strict Zod peers (OpenCode)
    const normalizedMcp = normalizeAcpMcpServers([
      { name: 'causyne-browser', command: '/usr/bin/node', args: ['bin/causyne.js', 'browser-mcp'] },
      { name: 'custom-env', command: 'mcp-bin', env: { FOO: 'bar' } },
      { name: 'remote-http', type: 'http', url: 'http://127.0.0.1:4321/mcp' }
    ]);
    assert.deepEqual(normalizedMcp, [
      { name: 'causyne-browser', command: '/usr/bin/node', args: ['bin/causyne.js', 'browser-mcp'], env: [] },
      { name: 'custom-env', command: 'mcp-bin', args: [], env: [{ name: 'FOO', value: 'bar' }] },
      { type: 'http', name: 'remote-http', url: 'http://127.0.0.1:4321/mcp', headers: [] }
    ]);
  } finally {
    if (prevHome === undefined) delete process.env.CAUSYNE_HOME;
    else process.env.CAUSYNE_HOME = prevHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});
