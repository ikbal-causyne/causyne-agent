// Cross-provider tool conformance.
//
// Causyne is meant to be the optimal body for *whatever* brain is plugged into it.
// That promise only holds if every tool in the catalogue is (a) executable, and
// (b) expressible in every provider's wire format. This suite is the contract:
// a provider is "supported" only when it passes every group below.
//
// Fully offline — the fetch stub in helpers/captureFetch.js means no network, no
// API key, and no spend.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';

import { TOOL_DEFINITIONS, toolRegistry, getDynamicTools } from '../src/tools/registry.js';
import { Sandbox } from '../src/sandbox.js';
import { CORE_TOOLS, PACKS, PACK_NAMES } from '../src/toolPacks.js';
import { sanitizeSequences } from '../src/contextManager.js';

import { AnthropicProvider } from '../src/providers/anthropic.js';
import { GeminiProvider } from '../src/providers/gemini.js';
import { OpenAIProvider } from '../src/providers/openai.js';
import { OpenAICompatibleProvider } from '../src/providers/openai-compatible.js';
import { DeepSeekProvider } from '../src/providers/deepseek.js';
import { DashscopeByokProvider } from '../src/providers/dashscope-byok.js';
import { QwenByokProvider } from '../src/providers/qwen-byok.js';
import { MoonshotProvider } from '../src/providers/moonshot.js';
import { MuseProvider } from '../src/providers/muse.js';
import { XAIProvider } from '../src/providers/xai.js';
import { OllamaProvider } from '../src/providers/ollama.js';

import { callAndCapture, CANNED } from './helpers/captureFetch.js';

// ---------------------------------------------------------------------------
// The provider matrix. Every entry in agentLoop.initializeProvider() appears here.
// ---------------------------------------------------------------------------

const PROVIDERS = [
  { id: 'openai',            Ctor: OpenAIProvider,           config: { apiKey: 'k', model: 'gpt-4o' },                     wire: 'openai' },
  { id: 'openai-compatible', Ctor: OpenAICompatibleProvider,  config: { apiKey: 'k', model: 'llama-3.3-70b' },              wire: 'openai' },
  { id: 'deepseek',          Ctor: DeepSeekProvider,          config: { apiKey: 'k', model: 'deepseek-v4-flash' },          wire: 'openai' },
  { id: 'moonshot',          Ctor: MoonshotProvider,          config: { apiKey: 'k', model: 'kimi-k3' },                    wire: 'openai' },
  { id: 'muse',              Ctor: MuseProvider,              config: { apiKey: 'k', model: 'muse-spark-1.3' },             wire: 'openai' },
  { id: 'xai',               Ctor: XAIProvider,               config: { apiKey: 'k', model: 'grok-4.5' },                   wire: 'openai' },
  { id: 'qwen',              Ctor: QwenByokProvider,          config: { apiKey: 'k', model: 'qwen3.7-plus' },               wire: 'openai' },
  { id: 'dashscope-byok',    Ctor: DashscopeByokProvider,     config: { apiKey: 'k', model: 'qwen3.7-plus' },               wire: 'openai' },
  { id: 'anthropic',         Ctor: AnthropicProvider,         config: { apiKey: 'k', model: 'claude-opus-5' },              wire: 'anthropic' },
  { id: 'gemini',            Ctor: GeminiProvider,            config: { apiKey: 'k', model: 'gemini-2.5-pro' },             wire: 'gemini' },
  { id: 'ollama',            Ctor: OllamaProvider,            config: { model: 'llama3' },                                  wire: 'ollama' }
];

// The three-block system stack agentLoop assembles on every step. Each block
// carries a sentinel so the suite can prove none of them were dropped.
const SENTINEL = {
  stable: 'CAUSYNE_SENTINEL_STABLE_SYSTEM_PROMPT',
  packs: 'CAUSYNE_SENTINEL_PACK_CATALOGUE',
  volatile: 'CAUSYNE_SENTINEL_VOLATILE_CONTEXT'
};

function systemStack() {
  return [
    { role: 'system', content: `You are Causyne. ${SENTINEL.stable}`, cacheAnchor: true },
    { role: 'system', content: `Capability packs. ${SENTINEL.packs}` },
    { role: 'system', content: `Autonomy mode C. ${SENTINEL.volatile}` },
    { role: 'user', content: 'Read /tmp/causyne-conformance.txt' }
  ];
}

// ---------------------------------------------------------------------------
// Payload readers — pull the tool declarations back out of each wire format.
// ---------------------------------------------------------------------------

function extractTools(wire, payload) {
  if (!payload) return [];

  if (wire === 'gemini') {
    const declarations = payload.tools?.[0]?.functionDeclarations || [];
    return declarations.map(d => ({ name: d.name, description: d.description, schema: d.parameters }));
  }

  if (wire === 'anthropic') {
    return (payload.tools || [])
      // The server-side tool_search tool is Anthropic's own; it carries a `type`
      // and no input_schema, and is not part of the Causyne catalogue.
      .filter(t => !t.type)
      .map(t => ({ name: t.name, description: t.description, schema: t.input_schema }));
  }

  // openai + ollama share the { type: 'function', function: {...} } envelope.
  return (payload.tools || []).map(t => {
    const fn = t.function || t;
    return { name: fn.name, description: fn.description, schema: fn.parameters };
  });
}

function systemTextOf(wire, payload) {
  if (!payload) return '';
  if (wire === 'gemini') {
    return (payload.systemInstruction?.parts || []).map(p => p.text || '').join('\n');
  }
  if (wire === 'anthropic') {
    const fromSystem = (payload.system || []).map(b => b.text || '').join('\n');
    const fromMessages = (payload.messages || [])
      .filter(m => m.role === 'system')
      .map(m => (typeof m.content === 'string' ? m.content : ''))
      .join('\n');
    return `${fromSystem}\n${fromMessages}`;
  }
  return (payload.messages || [])
    .filter(m => m.role === 'system')
    .map(m => (typeof m.content === 'string' ? m.content : ''))
    .join('\n');
}

// ---------------------------------------------------------------------------
// Recursive JSON Schema walker. Collects every violation rather than throwing on
// the first, so one run reports the full picture.
// ---------------------------------------------------------------------------

function inspectSchema(schema, path, wire, problems) {
  if (!schema || typeof schema !== 'object') return;

  if (schema.type === 'array' && !schema.items) {
    problems.push(`${path}: type 'array' without 'items' — rejected by OpenAI and Gemini`);
  }

  if (schema.type === 'object') {
    const properties = schema.properties;
    if (wire === 'gemini' && (!properties || Object.keys(properties).length === 0)) {
      problems.push(`${path}: OBJECT with empty 'properties' — Gemini rejects the whole request`);
    }
    if (properties) {
      for (const [key, value] of Object.entries(properties)) {
        inspectSchema(value, `${path}.${key}`, wire, problems);
      }
    }
    if (Array.isArray(schema.required) && properties) {
      for (const key of schema.required) {
        if (!(key in properties)) {
          problems.push(`${path}: 'required' names "${key}" which is not in 'properties'`);
        }
      }
    }
  }

  if (wire === 'gemini' && 'additionalProperties' in schema) {
    problems.push(`${path}: 'additionalProperties' reached Gemini — not in its OpenAPI subset`);
  }

  if (schema.items) inspectSchema(schema.items, `${path}[]`, wire, problems);
}

const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

// ---------------------------------------------------------------------------
// Group 1 — Registry integrity (provider-independent)
// ---------------------------------------------------------------------------

describe('Group 1: tool registry integrity', () => {
  test('every advertised tool is executable', () => {
    const orphans = TOOL_DEFINITIONS
      .map(def => def.name)
      .filter(name => typeof toolRegistry[name]?.execute !== 'function');

    assert.deepEqual(
      orphans, [],
      `Advertised to every LLM but absent from toolRegistry — guaranteed "Tool does not exist": ${orphans.join(', ')}`
    );
  });

  test('every registry entry is advertised', () => {
    const advertised = new Set(TOOL_DEFINITIONS.map(def => def.name));
    const unreachable = Object.keys(toolRegistry).filter(name => !advertised.has(name));

    assert.deepEqual(
      unreachable, [],
      `Executable but never shown to any model: ${unreachable.join(', ')}`
    );
  });

  test('every CORE_TOOLS entry exists in the catalogue', () => {
    const advertised = new Set(TOOL_DEFINITIONS.map(def => def.name));
    const missing = CORE_TOOLS.filter(name => !advertised.has(name));

    assert.deepEqual(missing, [], `CORE_TOOLS names with no schema: ${missing.join(', ')}`);
  });

  test('every capability pack member exists in the catalogue', () => {
    const advertised = new Set(TOOL_DEFINITIONS.map(def => def.name));
    const missing = [];
    for (const pack of PACK_NAMES) {
      for (const name of PACKS[pack]) {
        if (!advertised.has(name)) missing.push(`${pack}/${name}`);
      }
    }

    assert.deepEqual(missing, [], `Pack members with no schema: ${missing.join(', ')}`);
  });

  test('no tool name collides after dot normalisation', () => {
    const seen = new Map();
    const collisions = [];
    for (const def of TOOL_DEFINITIONS) {
      if (seen.has(def.name)) collisions.push(def.name);
      seen.set(def.name, true);
    }

    assert.deepEqual(collisions, [], `Duplicate tool names: ${collisions.join(', ')}`);
  });
});

// ---------------------------------------------------------------------------
// Groups 2 & 3 — per provider
// ---------------------------------------------------------------------------

for (const provider of PROVIDERS) {
  describe(`provider: ${provider.id}`, () => {
    const build = () => new provider.Ctor({ ...provider.config });
    const canned = CANNED[provider.wire];

    test('Group 2: the whole system stack survives into the request', async () => {
      const { payload } = await callAndCapture(build(), canned, systemStack(), {
        tools: TOOL_DEFINITIONS,
        temperature: 0.1,
        coreToolCount: CORE_TOOLS.length
      });

      const systemText = systemTextOf(provider.wire, payload);
      for (const [block, sentinel] of Object.entries(SENTINEL)) {
        assert.ok(
          systemText.includes(sentinel),
          `${provider.id} dropped the "${block}" system block — the model never sees it`
        );
      }
    });

    test('Group 3: every tool schema is valid for this provider', async () => {
      const { payload } = await callAndCapture(build(), canned, systemStack(), {
        tools: TOOL_DEFINITIONS,
        temperature: 0.1,
        coreToolCount: CORE_TOOLS.length
      });

      const tools = extractTools(provider.wire, payload);
      assert.equal(
        tools.length, TOOL_DEFINITIONS.length,
        `${provider.id} put ${tools.length} of ${TOOL_DEFINITIONS.length} tools on the wire`
      );

      const problems = [];
      for (const tool of tools) {
        if (!TOOL_NAME_PATTERN.test(tool.name || '')) {
          problems.push(`${tool.name}: name fails ^[a-zA-Z0-9_-]{1,64}$`);
        }
        if (!tool.description) {
          problems.push(`${tool.name}: missing description`);
        }
        // A tool may legitimately declare no parameters — but if it declares an
        // object schema, that schema has to be valid for this provider.
        if (tool.schema) inspectSchema(tool.schema, tool.name, provider.wire, problems);
      }

      assert.deepEqual(problems, [], `${provider.id} schema violations:\n  ${problems.join('\n  ')}`);
    });

    test('Group 4: a tool call round-trips back into the next request', async () => {
      const { result } = await callAndCapture(build(), canned, systemStack(), {
        tools: TOOL_DEFINITIONS,
        temperature: 0.1,
        coreToolCount: CORE_TOOLS.length
      });

      assert.ok(result.toolCalls?.length, `${provider.id} returned no tool calls`);

      // Replicate exactly what agentLoop does with the response.
      const messages = [...systemStack()];
      const assistantMsg = { role: 'assistant', content: result.content || '' };
      assistantMsg.tool_calls = result.toolCalls;
      messages.push(assistantMsg);

      for (const toolCall of result.toolCalls) {
        assert.ok(
          toolCall.id,
          `${provider.id} tool call has no id — sanitizeSequences will strip it from history`
        );
        assert.doesNotThrow(
          () => (typeof toolCall.function.arguments === 'string'
            ? JSON.parse(toolCall.function.arguments || '{}')
            : (toolCall.function.arguments || {})),
          `${provider.id} tool arguments are not parseable`
        );
        messages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          name: toolCall.function.name,
          content: JSON.stringify({ success: true })
        });
      }

      const cleaned = sanitizeSequences(messages);
      const survivor = cleaned.find(m => m.role === 'assistant' && Array.isArray(m.tool_calls));

      assert.ok(
        survivor && survivor.tool_calls.length === result.toolCalls.length,
        `${provider.id}: sanitizeSequences erased the tool calls — the model loses all memory of its own actions`
      );
    });
  });
}

// ---------------------------------------------------------------------------
// Group 6 — capability declaration
//
// These lock in the two properties a new provider is easy to forget, both of
// which fail silently rather than loudly if omitted.
// ---------------------------------------------------------------------------

describe('Group 6: provider capability declaration', () => {
  for (const provider of PROVIDERS) {
    test(`${provider.id} declares an image payload format`, () => {
      const instance = new provider.Ctor({ ...provider.config });
      assert.ok(
        ['openai', 'anthropic', 'gemini'].includes(instance.imagePayloadFormat),
        `${provider.id} must declare imagePayloadFormat — the agent loop cannot infer it from a minified class name`
      );
    });

    test(`${provider.id} declares a vision model list`, () => {
      const instance = new provider.Ctor({ ...provider.config });
      assert.ok(
        Array.isArray(instance.visionModels),
        `${provider.id} must declare visionModels (an empty array is a valid answer)`
      );
    });
  }

  test('a vision-capable model keeps image blocks; a blind one does not', () => {
    const imageMessage = {
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        { type: 'text', text: 'what is this' }
      ]
    };

    const seeing = new MoonshotProvider({ apiKey: 'k', model: 'kimi-k3' });
    assert.equal(seeing.supportsVision, true, 'kimi-k3 is natively multimodal');
    const keptContent = seeing.prepareMessages([imageMessage])[0].content;
    assert.ok(
      Array.isArray(keptContent) && keptContent.some(b => b.type === 'image_url'),
      'a vision model must keep the image, translated into its own wire shape'
    );

    const blind = new DeepSeekProvider({ apiKey: 'k', model: 'deepseek-v4-flash' });
    assert.equal(blind.supportsVision, false, 'the deepseek-chat line is text-only');
    assert.equal(
      typeof blind.prepareMessages([imageMessage])[0].content, 'string',
      'a text-only model must have the image flattened away, not passed through'
    );
  });

  test('ollama carries images in its own images[] field, not content blocks', () => {
    const llava = new OllamaProvider({ model: 'llava:13b' });
    assert.equal(llava.supportsVision, true, 'llava is a vision model');

    const prepared = llava.prepareMessages([{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
        { type: 'text', text: 'what is this' }
      ]
    }])[0];

    assert.deepEqual(prepared.images, ['AAAA'], 'Ollama reads images from a sibling images[] array');
    assert.equal(prepared.content, 'what is this', 'and plain text from content');
  });

  test('an explicit config flag overrides the model allowlist', () => {
    const forced = new OpenAICompatibleProvider({ apiKey: 'k', model: 'some-private-build', supportsVision: true });
    assert.equal(forced.supportsVision, true, 'custom endpoints serve models no allowlist can know');
  });

  test('vision-capable providers keep screenshot and vision_inspect_ui', async () => {
    const seeing = new GeminiProvider({ apiKey: 'k', model: 'gemini-2.5-pro' });
    const tools = await getDynamicTools('C', seeing.supportsVision, { grantAllTools: true });
    const names = tools.map(t => t.name);

    assert.ok(names.includes('screenshot'), 'a model that can see must keep screenshot');
    assert.ok(names.includes('vision_inspect_ui'), 'a model that can see must keep vision_inspect_ui');
  });
});

// ---------------------------------------------------------------------------
// Group 7 — the sandbox matches on the same names the agent loop produces
// ---------------------------------------------------------------------------

describe('Group 7: sandbox name matching', () => {
  // Sandbox reads its own config and ignores constructor arguments, so paths
  // used here must sit inside the default workspace or the path check fires
  // first and masks the risk classification under test.
  const sandbox = new Sandbox();
  const inWorkspace = name => path.join(os.homedir(), 'Desktop', name);

  test('destructive tools are risk-classified', () => {
    assert.equal(sandbox.validate('fs_delete', { path: inWorkspace('scratch.txt') }).risk, 'dangerous');
    assert.equal(sandbox.validate('fs_delete', { path: inWorkspace('scratchdir') }).risk, 'extreme');
    assert.equal(sandbox.validate('proc_term', { pid: 1234 }).risk, 'dangerous');
    assert.equal(sandbox.validate('fs_write', { path: inWorkspace('a.txt') }).risk, 'moderate');
  });

  test('SSRF protection reaches web_fetch', () => {
    const verdict = sandbox.validate('web_fetch', { url: 'http://127.0.0.1:8080/admin' });
    assert.equal(verdict.allowed, false, 'the loopback address must be refused');
    assert.equal(verdict.risk, 'forbidden');
  });

  test('heavy dependency downloads require consent', () => {
    const verdict = sandbox.validate('manage_local_dependencies', { action: 'pipInst', packages: ['pillow==11.3.0'] });
    assert.equal(verdict.risk, 'extreme', 'runtime dependency installation must reach the approval gate');
  });

  test('network writes require consent', () => {
    const web = sandbox.validate('web_fetch', { url: 'https://example.com/file', outputFile: inWorkspace('file.bin') });
    const asset = sandbox.validate('game_asset_fetch', { action: 'download_asset', url: 'https://kenney.nl/example.zip' });
    assert.equal(web.risk, 'extreme');
    assert.equal(asset.risk, 'extreme');
  });

  test('the persistent shell is classified like any other terminal', () => {
    const verdict = sandbox.validate('terminal_persistent_shell', { command: 'echo hello' });
    assert.ok(verdict.allowed);
    assert.ok(verdict.risk, 'the persistent shell must carry a risk level, not bypass classification');
  });

  test('every sandbox-classified name exists in the catalogue', () => {
    const advertised = new Set(TOOL_DEFINITIONS.map(d => d.name));
    const classified = ['fs_delete', 'proc_term', 'fs_write', 'fs_move', 'fs_edit', 'MultiEdit', 'web_fetch', 'game_asset_fetch', 'manage_local_dependencies', 'sysRun', 'sysRunBg', 'terminal_persistent_shell'];
    const unknown = classified.filter(name => !advertised.has(name));

    assert.deepEqual(unknown, [], `sandbox rules naming tools that do not exist: ${unknown.join(', ')}`);
  });
});

// ---------------------------------------------------------------------------
// Group 5 — parameters a provider rejects outright
// ---------------------------------------------------------------------------

describe('Group 5: forbidden request parameters', () => {
  // temperature / top_p / top_k return a 400 on these models. They are precisely
  // the models anthropic.js lists in TOOL_SEARCH_MODELS.
  const NO_SAMPLING = ['claude-opus-5', 'claude-opus-4-8', 'claude-sonnet-5', 'claude-fable-5'];

  for (const model of NO_SAMPLING) {
    test(`anthropic omits temperature on ${model}`, async () => {
      const provider = new AnthropicProvider({ apiKey: 'k', model });
      const { payload } = await callAndCapture(provider, CANNED.anthropic, systemStack(), {
        tools: TOOL_DEFINITIONS,
        temperature: 0.1,
        coreToolCount: CORE_TOOLS.length
      });

      assert.ok(
        !('temperature' in payload),
        `${model} rejects 'temperature' with a 400 — every request would fail`
      );
      assert.ok(!('top_p' in payload), `${model} rejects 'top_p'`);
      assert.ok(!('top_k' in payload), `${model} rejects 'top_k'`);
    });
  }

  test('anthropic still sends temperature on models that accept it', async () => {
    const provider = new AnthropicProvider({ apiKey: 'k', model: 'claude-3-5-sonnet-20240620' });
    const { payload } = await callAndCapture(provider, CANNED.anthropic, systemStack(), {
      tools: TOOL_DEFINITIONS,
      coreToolCount: CORE_TOOLS.length
    });

    assert.ok('temperature' in payload, 'older Anthropic models still take a temperature');
  });

  test('anthropic never defers every tool', async () => {
    const provider = new AnthropicProvider({ apiKey: 'k', model: 'claude-opus-5' });
    const { payload } = await callAndCapture(provider, CANNED.anthropic, systemStack(), {
      tools: TOOL_DEFINITIONS,
      coreToolCount: CORE_TOOLS.length
    });

    const nonDeferred = (payload.tools || []).filter(t => !t.defer_loading);
    assert.ok(
      nonDeferred.length > 0,
      'the API returns 400 "All tools have defer_loading set" when nothing is left loaded'
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// D-9 — reasoning control.
//
// Causyne sent no thinking parameter at all. On Claude Opus 4.8/4.7, Sonnet 5
// and the 4.6 pair, omitting it means the model runs with NO extended thinking
// — so the largest single lever on frontier-model quality was switched off for
// every user on those models.
//
// The rules are model-specific and unforgiving, which is why they are asserted
// here rather than trusted: `budget_tokens` is REJECTED with a 400 on the
// adaptive family, Fable 5 rejects ANY explicit thinking configuration, and
// effort belongs inside `output_config` with a lower ceiling on some models.
// Getting one of these wrong fails every request for that model.
// ───────────────────────────────────────────────────────────────────────────
describe('D-9: Anthropic reasoning configuration is model-correct', () => {
  const build = (model, overrides = {}) =>
    new AnthropicProvider({ apiKey: 'test', model, ...overrides });

  test('adaptive thinking is requested where omission would disable it', () => {
    for (const model of ['claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-opus-4-6']) {
      assert.deepStrictEqual(build(model).buildThinking(), { type: 'adaptive' },
        `${model} needs an explicit adaptive request`);
    }
  });

  test('budget_tokens is never sent to a model that rejects it', () => {
    for (const model of ['claude-fable-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-5']) {
      const thinking = build(model, { reasoningBudgetTokens: 8000 }).buildThinking();
      assert.ok(!thinking || thinking.budget_tokens === undefined,
        `${model} returns a 400 for budget_tokens`);
    }
  });

  test('Fable 5 receives no explicit thinking configuration at all', () => {
    assert.strictEqual(build('claude-fable-5').buildThinking(), null);
    assert.strictEqual(build('claude-fable-5', { reasoningEffort: 'off' }).buildThinking(), null,
      'even disabling is a 400 on a model where thinking is always on');
  });

  test('pre-adaptive models still use a fixed budget, and only when configured', () => {
    assert.strictEqual(build('claude-sonnet-4-5').buildThinking(), null);
    assert.deepStrictEqual(
      build('claude-sonnet-4-5', { reasoningBudgetTokens: 4096 }).buildThinking(),
      { type: 'enabled', budget_tokens: 4096 });
  });

  test('effort is clamped to what the model accepts, never passed through blind', () => {
    assert.strictEqual(build('claude-opus-5', { reasoningEffort: 'max' }).resolveEffort(), 'max');
    assert.strictEqual(build('claude-opus-4-6', { reasoningEffort: 'max' }).resolveEffort(), 'high',
      'the 4.6 family stops at high');
    assert.strictEqual(build('claude-haiku-4-5', { reasoningEffort: 'high' }).resolveEffort(), null,
      'this model rejects effort outright');
    assert.strictEqual(build('claude-opus-5', { reasoningEffort: 'nonsense' }).resolveEffort(), null);
    assert.strictEqual(build('claude-opus-5').resolveEffort(), null,
      'unset means let the API choose, not guess a default');
  });

  test('disabling thinking is only attempted where the model would otherwise think', () => {
    assert.deepStrictEqual(build('claude-opus-5', { reasoningEffort: 'off' }).buildThinking(),
      { type: 'disabled' });
    assert.strictEqual(build('claude-opus-4-8', { reasoningEffort: 'off' }).buildThinking(), null,
      'omission already means no thinking here — sending disabled adds nothing');
  });

  test('the reasoning summary is opt-in, because it costs output tokens', () => {
    assert.strictEqual(build('claude-opus-5').buildThinking().display, undefined);
    assert.strictEqual(build('claude-opus-5', { showReasoning: true }).buildThinking().display, 'summarized');
  });
});
