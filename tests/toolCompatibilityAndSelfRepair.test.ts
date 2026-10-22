import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import { TOOL_DEFINITIONS } from '../src/tools/registry.js';
import {
  scanAndAdaptToolsForProvider,
  decodeFreeFormArguments,
  adaptSchemaForGemini,
  adaptSchemaForAnthropic,
  adaptSchemaForOpenAI
} from '../src/tools/toolScanner.js';
import {
  repairJsonArguments,
  resolveParameterAliases,
  coerceArgumentTypes,
  normalizePaths,
  selfRepairToolCall,
  generateSelfRepairDiagnostic
} from '../src/tools/toolSelfRepair.js';

describe('Universal Tool Compatibility & Scanner (toolsScan)', () => {
  test('Gemini dialect: adapts all 80 tools with 0 additionalProperties and 0 empty objects', () => {
    const report = scanAndAdaptToolsForProvider(TOOL_DEFINITIONS, 'gemini');

    assert.equal(report.provider, 'gemini');
    assert.equal(report.totalTools, TOOL_DEFINITIONS.length);
    assert.ok(report.adaptedTools.length === TOOL_DEFINITIONS.length);

    // Verify no additionalProperties exist anywhere in adapted schemas
    function assertNoAdditionalProperties(node: any, pathStr: string) {
      if (!node || typeof node !== 'object') return;
      assert.equal(
        'additionalProperties' in node, false,
        `Gemini rejection hazard: additionalProperties found at ${pathStr}`
      );
      if (node.properties) {
        for (const [k, v] of Object.entries(node.properties)) {
          assertNoAdditionalProperties(v, `${pathStr}.${k}`);
        }
      }
      if (node.items) {
        assertNoAdditionalProperties(node.items, `${pathStr}[]`);
      }
    }

    // Verify no empty object schemas exist
    function assertNoEmptyObjects(node: any, pathStr: string) {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'object') {
        const propCount = node.properties ? Object.keys(node.properties).length : 0;
        assert.ok(propCount > 0, `Gemini rejection hazard: empty object at ${pathStr}`);
      }
      if (node.properties) {
        for (const [k, v] of Object.entries(node.properties)) {
          assertNoEmptyObjects(v, `${pathStr}.${k}`);
        }
      }
      if (node.items) {
        assertNoEmptyObjects(node.items, `${pathStr}[]`);
      }
    }

    for (const tool of report.adaptedTools as any[]) {
      assert.ok(/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name));
      assert.ok(tool.description, `Tool ${tool.name} missing description`);
      if (tool.parameters) {
        assertNoAdditionalProperties(tool.parameters, tool.name);
        assertNoEmptyObjects(tool.parameters, tool.name);
      }
    }
  });

  test('Gemini free-form decoding roundtrips stringified objects back to native objects', () => {
    const rawSchema = {
      type: 'object',
      properties: {
        url: { type: 'string' },
        headers: { type: 'object' } // empty object schema
      }
    };

    const rewritten: string[][] = [];
    const adapted: any = adaptSchemaForGemini(rawSchema, [], rewritten);

    assert.equal(adapted.properties.headers.type, 'string');
    assert.ok(rewritten.length === 1);
    assert.deepEqual(rewritten[0], ['headers']);

    // Model returns headers as JSON string
    const modelOutput = {
      url: 'https://causyne.com',
      headers: '{"Authorization":"Bearer test-token","Content-Type":"application/json"}'
    };

    const decoded = decodeFreeFormArguments(modelOutput, rewritten);
    assert.equal(typeof decoded.headers, 'object');
    assert.equal((decoded.headers as any).Authorization, 'Bearer test-token');
    assert.equal((decoded.headers as any)['Content-Type'], 'application/json');
  });

  test('Anthropic dialect: guarantees input_schema type is object and tool names are valid', () => {
    const report = scanAndAdaptToolsForProvider(TOOL_DEFINITIONS, 'anthropic', {
      coreToolCount: 10,
      useToolSearch: true
    });

    assert.equal(report.adaptedTools.length, TOOL_DEFINITIONS.length);

    for (let i = 0; i < report.adaptedTools.length; i++) {
      const tool: any = report.adaptedTools[i];
      assert.ok(/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name));
      assert.equal(tool.input_schema.type, 'object');
      assert.ok(typeof tool.input_schema.properties === 'object');
      if (i >= 10) {
        assert.equal(tool.defer_loading, true);
      } else {
        assert.equal(tool.defer_loading, undefined);
      }
    }
  });

  test('OpenAI dialect: guarantees standard function tool format and clean typing', () => {
    const report = scanAndAdaptToolsForProvider(TOOL_DEFINITIONS, 'openai');
    assert.equal(report.adaptedTools.length, TOOL_DEFINITIONS.length);

    for (const tool of report.adaptedTools as any[]) {
      assert.equal(tool.type, 'function');
      assert.ok(tool.function.name);
      assert.ok(tool.function.description);
      assert.equal(tool.function.parameters.type, 'object');
    }
  });
});

describe('Universal Tool Self-Repair & Healing Buffer (toolsSelfRepair)', () => {
  test('repairJsonArguments: strips markdown fences and parses valid JSON', () => {
    const markdownInput = '```json\n{\n  "path": "/workspace/main.ts",\n  "content": "console.log(42);"\n}\n```';
    const result = repairJsonArguments(markdownInput);
    assert.equal(result.repaired, true);
    assert.equal(result.args.path, '/workspace/main.ts');
    assert.equal(result.args.content, 'console.log(42);');
  });

  test('repairJsonArguments: handles conversational filler around JSON', () => {
    const conversational = 'Certainly! Here is the command to run:\n{"command":"git status"}\nLet me know if you need anything else.';
    const result = repairJsonArguments(conversational);
    assert.equal(result.repaired, true);
    assert.equal(result.args.command, 'git status');
  });

  test('repairJsonArguments: heals trailing commas', () => {
    const trailingCommaJson = '{"path": "/tmp/test", "recursive": true, "items": [1, 2,],}';
    const result = repairJsonArguments(trailingCommaJson);
    assert.equal(result.repaired, true);
    assert.equal(result.args.path, '/tmp/test');
    assert.equal(result.args.recursive, true);
    assert.deepEqual(result.args.items, [1, 2]);
  });

  test('repairJsonArguments: heals single-quoted JSON keys and values', () => {
    const singleQuoted = "{'path': '/home/dev', 'filter': '*.ts'}";
    const result = repairJsonArguments(singleQuoted);
    assert.equal(result.repaired, true);
    assert.equal(result.args.path, '/home/dev');
    assert.equal(result.args.filter, '*.ts');
  });

  test('repairJsonArguments: heals truncated JSON by balancing braces', () => {
    const truncated = '{"command": "echo hello", "options": {"cwd": "/tmp"';
    const result = repairJsonArguments(truncated);
    assert.equal(result.repaired, true);
    assert.equal(result.args.command, 'echo hello');
    assert.deepEqual(result.args.options, { cwd: '/tmp' });
  });

  test('resolveParameterAliases: maps filepath/targetFile -> path', () => {
    const schema = {
      properties: {
        path: { type: 'string' },
        content: { type: 'string' }
      }
    };

    const res1 = resolveParameterAliases('fs_read', { filepath: '/etc/hosts' }, schema);
    assert.equal(res1.repaired, true);
    assert.equal(res1.args.path, '/etc/hosts');

    const res2 = resolveParameterAliases('fs_write', { targetFile: '/tmp/test.js', contents: 'ok' }, schema);
    assert.equal(res2.repaired, true);
    assert.equal(res2.args.path, '/tmp/test.js');
    assert.equal(res2.args.content, 'ok');
  });

  test('resolveParameterAliases: maps cmd/script -> command for terminal tools', () => {
    const schema = {
      properties: {
        command: { type: 'string' }
      }
    };

    const res = resolveParameterAliases('sysRun', { cmd: 'cargo test' }, schema);
    assert.equal(res.repaired, true);
    assert.equal(res.args.command, 'cargo test');
  });

  test('resolveParameterAliases: maps q/searchTerm -> query for search tools', () => {
    const schema = {
      properties: {
        query: { type: 'string' }
      }
    };

    const res = resolveParameterAliases('web_search', { q: 'Causyne AI agent' }, schema);
    assert.equal(res.repaired, true);
    assert.equal(res.args.query, 'Causyne AI agent');
  });

  test('coerceArgumentTypes: coerces string numbers and booleans into correct types', () => {
    const schema = {
      properties: {
        port: { type: 'integer' },
        scale: { type: 'number' },
        recursive: { type: 'boolean' },
        tags: { type: 'array' },
        meta: { type: 'object' }
      }
    };

    const raw = {
      port: '8080',
      scale: '1.75',
      recursive: 'true',
      tags: '["alpha", "beta"]',
      meta: '{"active": true}'
    };

    const res = coerceArgumentTypes('testTool', raw, schema);
    assert.equal(res.repaired, true);
    assert.equal(res.args.port, 8080);
    assert.equal(res.args.scale, 1.75);
    assert.equal(res.args.recursive, true);
    assert.deepEqual(res.args.tags, ['alpha', 'beta']);
    assert.deepEqual(res.args.meta, { active: true });
  });

  test('normalizePaths: converts relative paths to absolute paths', () => {
    const cwd = '/test/workspace';
    const res = normalizePaths({ path: 'src/index.ts', destination: 'dist/index.js' }, cwd);
    assert.equal(res.repaired, true);
    assert.equal(res.args.path, path.resolve(cwd, 'src/index.ts'));
    assert.equal(res.args.destination, path.resolve(cwd, 'dist/index.js'));
  });

  test('selfRepairToolCall: orchestrates end-to-end healing on broken tool calls', () => {
    const brokenToolCall = {
      function: {
        name: 'fs_write',
        arguments: '```json\n{\n  "filepath": "config.json",\n  "contents": "{\\"version\\": 1}",\n}\n```'
      }
    };

    const schema = {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' }
      },
      required: ['path', 'content']
    };

    const result = selfRepairToolCall(brokenToolCall, schema, { cwd: '/my/project' });
    assert.equal(result.repaired, true);
    assert.equal(result.name, 'fs_write');
    assert.equal(result.args.path, path.resolve('/my/project', 'config.json'));
    assert.equal(result.args.content, '{"version": 1}');
    assert.ok(result.repairs.length >= 3);
  });

  test('generateSelfRepairDiagnostic: formats actionable self-repair feedback', () => {
    const schema = {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute file path' },
        content: { type: 'string', description: 'Text content to write' }
      },
      required: ['path', 'content']
    };

    const diagnostic: any = generateSelfRepairDiagnostic('fs_write', { path: '/tmp/test.txt' }, 'Missing required "content" argument', schema);
    assert.equal(diagnostic.success, false);
    assert.ok(diagnostic.error.includes('Missing required "content" argument'));
    assert.equal(diagnostic.selfRepairGuidance.tool, 'fs_write');
    assert.ok(diagnostic.selfRepairGuidance.expectedParameters.content);
    assert.ok(diagnostic.selfRepairGuidance.instruction);
  });
});
