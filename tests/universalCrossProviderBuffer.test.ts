import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { TOOL_DEFINITIONS, scanToolRegistry } from '../src/tools/registry.js';
import {
  ALL_PROVIDER_DIALECTS,
  scanAndAdaptToolsForProvider,
  scanAllProvidersCompatibility,
  type ToolDefinition
} from '../src/tools/toolScanner.js';
import { selfRepairToolCall } from '../src/tools/toolSelfRepair.js';
import { validateToolArguments } from '../src/tools/argumentValidation.js';
import { GeminiProvider } from '../src/providers/gemini.js';
import { AnthropicProvider } from '../src/providers/anthropic.js';
import { QwenByokProvider } from '../src/providers/qwen-byok.js';
import { OllamaProvider } from '../src/providers/ollama.js';
import { DeepSeekProvider } from '../src/providers/deepseek.js';
import { validateGameEngineJob } from '../src/creative/liveBridge.js';

function assertUniversalWireSchemaClean(node: any, wire: string, nodePath: string): void {
  if (!node || typeof node !== 'object') return;

  assert.equal(Array.isArray(node.type), false, `${wire}:${nodePath} still has union type array`);
  assert.ok(!('oneOf' in node), `${wire}:${nodePath} still contains oneOf`);
  assert.ok(!('anyOf' in node), `${wire}:${nodePath} still contains anyOf`);
  assert.ok(!('allOf' in node), `${wire}:${nodePath} still contains allOf`);
  assert.ok(!('$ref' in node), `${wire}:${nodePath} still contains $ref`);

  if (nodePath !== 'root') {
    assert.ok(typeof node.type === 'string' && node.type.length > 0, `${wire}:${nodePath} missing compiled type`);
  }

  if (node.type === 'array') {
    assert.ok(node.items && typeof node.items === 'object', `${wire}:${nodePath} array missing items`);
  }

  if (node.type === 'object' && Array.isArray(node.required) && node.properties) {
    for (const req of node.required) {
      assert.ok(req in node.properties, `${wire}:${nodePath} required '${req}' missing from properties`);
    }
  }

  if (wire === 'gemini') {
    assert.ok(!('additionalProperties' in node), `gemini:${nodePath} still has additionalProperties`);
    assert.ok(!('default' in node), `gemini:${nodePath} still has default`);
    if (node.type === 'object') {
      assert.ok(node.properties && Object.keys(node.properties).length > 0, `gemini:${nodePath} has empty object`);
    }
    if (Array.isArray(node.enum)) {
      assert.equal(node.type, 'string', `gemini:${nodePath} enum must be string type`);
      assert.ok(node.enum.every((v: unknown) => typeof v === 'string'), `gemini:${nodePath} enum has non-string items`);
    }
  }

  if (node.properties && typeof node.properties === 'object') {
    for (const [k, v] of Object.entries(node.properties)) {
      assertUniversalWireSchemaClean(v, wire, `${nodePath}.${k}`);
    }
  }
  if (node.items) {
    assertUniversalWireSchemaClean(node.items, wire, `${nodePath}[]`);
  }
}

describe('Universal Cross-Provider Matrix & Self-Repair Buffer', () => {
  test('toolsScan compiles all registered native tools cleanly across all 15 provider dialects', async () => {
    const matrix = await scanToolRegistry('all');
    assert.equal(matrix.providersScanned, ALL_PROVIDER_DIALECTS.length);
    assert.equal(matrix.totalTools, TOOL_DEFINITIONS.length);
    assert.equal(matrix.allUniversalReady, true);

    for (const provider of ALL_PROVIDER_DIALECTS) {
      const report = matrix.reports[provider];
      assert.ok(report, `Missing scan report for provider ${provider}`);
      assert.equal(report.residualIncompatibleCount, 0, `${provider} had residual schema errors`);
      assert.equal(report.universalReady, true, `${provider} is not universalReady`);
      assert.equal(report.adaptedTools.length, TOOL_DEFINITIONS.length);

      for (const adapted of report.adaptedTools as any[]) {
        const schema = adapted.parameters || adapted.input_schema || adapted.inputSchema || adapted.function?.parameters;
        if (schema) {
          assertUniversalWireSchemaClean(schema, provider, `${adapted.name || adapted.function?.name}`);
        }
      }
    }
  });

  test('toolsScan compiles adversarial MCP/plugin schemas ($defs/$ref, allOf, oneOf, anyOf, empty array items, typeless fields)', () => {
    const trickyMcpTool: ToolDefinition = {
      name: 'mcp.acme.very.long.namespace.operation.that.clearly.exceeds.sixty.four.characters.limit',
      parameters: {
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        $defs: {
          TargetRef: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              priority: { type: 'integer', enum: [1, 2, 3], default: 1 }
            },
            required: ['id']
          }
        },
        allOf: [
          {
            type: 'object',
            properties: {
              target: { $ref: '#/$defs/TargetRef' },
              tags: { type: 'array' },
              records: { type: 'array', items: { type: 'object' } },
              dynamicValue: { description: 'Arbitrary value with no explicit type' },
              mode: { oneOf: [{ type: 'string', enum: ['fast', 'full'] }, { type: 'integer' }] },
              nullableNote: { anyOf: [{ type: 'string' }, { type: 'null' }] }
            },
            required: ['target', 'ghostRequiredKey']
          }
        ]
      }
    };

    const matrix = scanAllProvidersCompatibility([trickyMcpTool]);
    assert.equal(matrix.allUniversalReady, true);

    for (const provider of ALL_PROVIDER_DIALECTS) {
      const report = matrix.reports[provider]!;
      assert.equal(report.residualIncompatibleCount, 0, `Residual errors on ${provider}`);
      const adapted = report.adaptedTools[0] as any;
      const wireName = adapted.name || adapted.function?.name;
      assert.ok(/^[a-zA-Z0-9_-]{1,64}$/.test(wireName), `Invalid compiled name '${wireName}' on ${provider}`);
      const wireSchema = adapted.parameters || adapted.input_schema || adapted.inputSchema || adapted.function?.parameters;
      assertUniversalWireSchemaClean(wireSchema, provider, wireName);
    }

    const geminiReport = matrix.reports['gemini']!;
    const paths = geminiReport.freeFormPaths.get((geminiReport.adaptedTools[0] as any).name);
    assert.ok(paths && paths.length >= 2, 'Gemini report must record rewritten array-object & polymorphic paths');
  });

  test('toolsSelfRepair decodes adapted polymorphic/free-form arguments and coerces nested action schemas recursively', () => {
    const browserDef = TOOL_DEFINITIONS.find((t) => t.name === 'browser_act')!;
    const browserScan = scanAndAdaptToolsForProvider([browserDef], 'gemini');
    const paths = browserScan.freeFormPaths.get('browser_act');
    assert.ok(paths && paths.some((p) => p.join('.') === 'actions.[].filePath'));

    const repaired = selfRepairToolCall(
      {
        function: {
          name: 'browser_act',
          arguments: JSON.stringify({
            actions: [
              { type: 'preview', filePath: 'index.html' },
              { type: 'upload', selector: '#f', filePath: '["hero.png","detail.png"]' },
              { type: 'wait', timeout: '5s', waitForNetwork: 'true' },
              { type: 'viewport', width: '1280', height: '720' }
            ]
          })
        }
      },
      browserDef.parameters as any,
      { cwd: process.cwd(), freeFormPaths: paths }
    );

    assert.equal(repaired.error, undefined);
    assert.equal(repaired.args.actions[0].filePath, 'index.html');
    assert.deepEqual(repaired.args.actions[1].filePath, ['hero.png', 'detail.png']);
    assert.equal(repaired.args.actions[2].timeout, 5000);
    assert.equal(repaired.args.actions[2].waitForNetwork, true);
    assert.equal(repaired.args.actions[3].width, 1280);
    assert.equal(repaired.args.actions[3].height, 720);
    assert.deepEqual(validateToolArguments(repaired.args, browserDef.parameters), []);

    // Plain numeric filename string must never be corrupted to a number when decoding filePath
    const numericNameRepair = selfRepairToolCall(
      {
        function: {
          name: 'browser_act',
          arguments: JSON.stringify({
            actions: [{ type: 'upload', selector: '#f', filePath: '42' }]
          })
        }
      },
      browserDef.parameters as any,
      { cwd: process.cwd(), freeFormPaths: paths }
    );
    assert.equal(numericNameRepair.args.actions[0].filePath, '42');
    assert.deepEqual(validateToolArguments(numericNameRepair.args, browserDef.parameters), []);

    // Polymorphic scalar + container decoding for creative_apps.propertyValue
    const creativeDef = TOOL_DEFINITIONS.find((t) => t.name === 'creative_apps')!;
    const creativeScan = scanAndAdaptToolsForProvider([creativeDef], 'gemini');
    const creativePaths = creativeScan.freeFormPaths.get('creative_apps');

    const scalarCases: Array<{ raw: string; expected: unknown }> = [
      { raw: '42', expected: 42 },
      { raw: '-3.5', expected: -3.5 },
      { raw: 'true', expected: true },
      { raw: 'false', expected: false },
      { raw: '{"X":10,"Y":20,"Z":30}', expected: { X: 10, Y: 20, Z: 30 } },
      { raw: '[1,2,3]', expected: [1, 2, 3] },
      { raw: '"42"', expected: '42' },
      { raw: 'HeroLight', expected: 'HeroLight' },
      { raw: '007', expected: '007' }
    ];

    for (const { raw, expected } of scalarCases) {
      const healed = selfRepairToolCall(
        {
          function: {
            name: 'creative_apps',
            arguments: JSON.stringify({
              action: 'engine_bridge',
              engine: 'unreal',
              engineOperation: 'remote_control',
              objectPath: '/Game/Main.Light',
              propertyName: 'Intensity',
              propertyValue: raw
            })
          }
        },
        creativeDef.parameters as any,
        { cwd: process.cwd(), freeFormPaths: creativePaths }
      );
      assert.deepEqual(healed.args.propertyValue, expected, `Failed selfRepairToolCall on propertyValue=${raw}`);
      assert.deepEqual(validateToolArguments(healed.args, creativeDef.parameters), []);

      const job = validateGameEngineJob({
        engine: 'unreal',
        engineOperation: 'remote_control',
        objectPath: '/Game/Main.Light',
        propertyName: 'Intensity',
        propertyValue: raw
      });
      assert.deepEqual(job.propertyValue, expected, `Failed validateGameEngineJob on propertyValue=${raw}`);
    }
  });

  test('Gemini provider batches parallel tool responses, survives malformed history, and decodes adapted args', async () => {
    const provider = new GeminiProvider({ apiKey: 'test', model: 'gemini-2.5-pro' });
    const browserDef = TOOL_DEFINITIONS.find((t) => t.name === 'browser_act')!;
    let capturedPayload: any = null;
    const origFetch = globalThis.fetch;

    try {
      globalThis.fetch = (async (_url: any, init: any) => {
        capturedPayload = JSON.parse(init.body);
        return {
          ok: true,
          json: async () => ({
            candidates: [{
              content: {
                parts: [{
                  functionCall: {
                    name: 'browser_act',
                    args: {
                      actions: [{ type: 'upload', selector: '#in', filePath: '["a.png","b.png"]' }]
                    }
                  }
                }]
              }
            }],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 }
          })
        } as any;
      }) as typeof fetch;

      const res = await provider.chat([
        { role: 'user', content: 'run parallel tools' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'fs_read', arguments: '{broken_json' } }]
        },
        { role: 'tool', name: 'fs_read', tool_call_id: 'c1', content: 'ok-1' },
        { role: 'tool', name: 'fs_list', tool_call_id: 'c2', content: 'ok-2' }
      ], { tools: [browserDef] });

      const toolResponseTurn = capturedPayload.contents.find(
        (c: any) => c.role === 'user' && Array.isArray(c.parts) && c.parts.some((p: any) => p.functionResponse)
      );
      assert.ok(toolResponseTurn);
      assert.equal(toolResponseTurn.parts.length, 2, 'Consecutive tool turns must be batched into one Gemini user turn');
      assert.ok(res.toolCalls && res.toolCalls[0]);
      const parsed = JSON.parse(res.toolCalls[0].function.arguments);
      assert.deepEqual(parsed.actions[0].filePath, ['a.png', 'b.png']);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test('Anthropic provider preserves system cache_control, translates image_url, sanitizes ids, and clamps budget', async () => {
    const provider = new AnthropicProvider({
      apiKey: 'test',
      model: 'claude-sonnet-4-5',
      reasoningBudgetTokens: 8000
    });
    let capturedPayload: any = null;
    const origFetch = globalThis.fetch;

    try {
      globalThis.fetch = (async (_url: any, init: any) => {
        capturedPayload = JSON.parse(init.body);
        return {
          ok: true,
          json: async () => ({
            content: [{ type: 'tool_use', id: 'bad:id/1', name: 'fs.read', input: { path: 'a.txt' } }],
            usage: { input_tokens: 10, output_tokens: 5 }
          })
        } as any;
      }) as typeof fetch;

      const res = await provider.chat([
        { role: 'system', content: 'Core prompt', cacheAnchor: true },
        {
          role: 'user',
          spillPath: '/tmp/internal',
          content: [
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
            { type: 'text', text: 'inspect' }
          ]
        }
      ], { maxTokens: 4096, tools: TOOL_DEFINITIONS.slice(0, 3) });

      assert.equal(capturedPayload.system[0].cache_control?.type, 'ephemeral');
      assert.equal(capturedPayload.messages[0].content[0].type, 'image');
      assert.equal('spillPath' in capturedPayload.messages[0], false);
      assert.ok(capturedPayload.thinking.budget_tokens < capturedPayload.max_tokens);
      assert.equal(res.toolCalls?.[0]?.id, 'bad_id_1');
      assert.equal(res.toolCalls?.[0]?.function.name, 'fs_read');
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test('OpenAI-compatible providers and Ollama normalize object args, missing ids, and <tool_call> fallbacks', async () => {
    const origFetch = globalThis.fetch;
    try {
      const qwen = new QwenByokProvider({ apiKey: 'sk-test', model: 'qwen3.7-plus' });
      const deepseek = new DeepSeekProvider({ apiKey: 'sk-test', model: 'deepseek-v4-flash' });

      globalThis.fetch = (async () => ({
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: 'Running browser.\n<tool_call>{"name":"browser.act","arguments":{"actions":[{"type":"upload","selector":"#f","filePath":"[\\"a.png\\",\\"b.png\\"]"}]}}</tool_call>'
            }
          }],
          usage: { prompt_tokens: 12, completion_tokens: 8 }
        })
      })) as any;

      const browserDef = TOOL_DEFINITIONS.find((t) => t.name === 'browser_act')!;
      const qwenRes = await qwen.chat([{ role: 'user', content: 'upload' }], { tools: [browserDef] });
      assert.equal(qwenRes.content, 'Running browser.');
      assert.ok(qwenRes.toolCalls && qwenRes.toolCalls[0]?.id);
      assert.equal(qwenRes.toolCalls?.[0]?.function.name, 'browser_act');
      assert.deepEqual(JSON.parse(qwenRes.toolCalls![0]!.function.arguments).actions[0].filePath, ['a.png', 'b.png']);

      // Verify toolsSelfRepair heals stringified object params returned by any OpenAI model
      const webFetch = TOOL_DEFINITIONS.find((t) => t.name === 'web_fetch')!;
      const healedFetch = selfRepairToolCall(
        { function: { name: 'web.fetch', arguments: { url: 'https://causyne.com', headers: '{"Accept":"application/json"}' } } },
        webFetch.parameters as any
      );
      assert.equal(healedFetch.name, 'web_fetch');
      assert.deepEqual(healedFetch.args.headers, { Accept: 'application/json' });

      globalThis.fetch = (async () => ({
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: '',
              tool_calls: [{ function: { name: 'fs_read', arguments: { path: 'README.md' } } }]
            }
          }]
        })
      })) as any;
      const dsRes = await deepseek.chat([{ role: 'user', content: 'read' }], { tools: [TOOL_DEFINITIONS[0]] });
      assert.ok(dsRes.toolCalls?.[0]?.id);
      assert.equal(typeof dsRes.toolCalls?.[0]?.function.arguments, 'string');

      const ollama = new OllamaProvider({ model: 'llama3' });
      let capturedOllama: any = null;
      globalThis.fetch = (async (_url: any, init: any) => {
        capturedOllama = JSON.parse(init.body);
        return {
          ok: true,
          json: async () => ({
            message: {
              content: '<tool_call>{"name":"fs_read","arguments":{"path":"package.json"}}</tool_call>'
            },
            prompt_eval_count: 5,
            eval_count: 4
          })
        } as any;
      }) as any;

      const ollamaRes = await ollama.chat([
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'c1', type: 'function', function: { name: 'fs_read', arguments: '{"path":"a.txt"}' } }]
        }
      ], { tools: [TOOL_DEFINITIONS[0]] });

      assert.equal(typeof capturedOllama.messages[1].tool_calls[0].function.arguments, 'object');
      assert.equal(ollamaRes.toolCalls?.[0]?.function.name, 'fs_read');
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
