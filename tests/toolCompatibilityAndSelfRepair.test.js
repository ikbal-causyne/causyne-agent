import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { sysRun, clearSysRunCache, SEARCH_COMMAND_PATTERN, IDEMPOTENT_COMMAND_PATTERN } from '../src/tools/sysRun.js';
import {
  scanAndAdaptToolsForProvider,
  adaptSchemaForGemini,
  adaptSchemaForAnthropic,
  adaptSchemaForOpenAI
} from '../src/tools/toolScanner.js';
import {
  selfRepairToolCall,
  repairJsonArguments,
  resolveParameterAliases,
  coerceArgumentTypes,
  canonicalizeToolName
} from '../src/tools/toolSelfRepair.js';
import { mapNativeToolToCausyne, AntigravityProvider } from '../src/providers/antigravity.js';

describe('sysRun: Semantic Exit Code Normalization & Anti-Repeat Caching', () => {
  beforeEach(() => {
    clearSysRunCache();
  });

  test('SEARCH_COMMAND_PATTERN detects search commands like grep, diff, test, which', () => {
    assert.ok(SEARCH_COMMAND_PATTERN.test('ls -la | grep -i savanna'));
    assert.ok(SEARCH_COMMAND_PATTERN.test('grep pattern file.txt'));
    assert.ok(SEARCH_COMMAND_PATTERN.test('diff fileA fileB'));
    assert.ok(SEARCH_COMMAND_PATTERN.test('test -f /tmp/foo'));
    assert.ok(SEARCH_COMMAND_PATTERN.test('which python3'));
    assert.ok(!SEARCH_COMMAND_PATTERN.test('rm -rf /tmp/foo'));
    assert.ok(!SEARCH_COMMAND_PATTERN.test('npm install'));
  });

  test('IDEMPOTENT_COMMAND_PATTERN identifies read-only check and diagnostic commands', () => {
    assert.ok(!IDEMPOTENT_COMMAND_PATTERN.test('python3 -c "import numpy; print(numpy.__version__)"'));
    assert.ok(!IDEMPOTENT_COMMAND_PATTERN.test('ls -la && rm file'));
    assert.ok(!IDEMPOTENT_COMMAND_PATTERN.test('git tag new-release'));
    assert.ok(IDEMPOTENT_COMMAND_PATTERN.test('node -v'));
    assert.ok(IDEMPOTENT_COMMAND_PATTERN.test('ls -la'));
    assert.ok(IDEMPOTENT_COMMAND_PATTERN.test('git status'));
    assert.ok(!IDEMPOTENT_COMMAND_PATTERN.test('git push origin main'));
    assert.ok(!IDEMPOTENT_COMMAND_PATTERN.test('rm -f test.txt'));
  });

  test('sysRun treats grep with 0 matches (exit code 1) as success: true with (no matches found)', { skip: process.platform === 'win32' }, async () => {
    // Run grep for a non-existent random token in this test file
    const res = await sysRun.execute({
      command: 'echo "hello world" | grep -i "nonexistent_token_xyz_123"'
    });

    assert.strictEqual(res.success, true, 'Zero-match search must resolve with success: true');
    assert.strictEqual(res.exitCode, 1, 'POSIX exit code 1 is preserved');
    assert.ok(res.output.includes('(no matches found)'));
    assert.ok(res.note && res.note.includes('0 search matches'));
  });

  test('sysRun treats grep with matching lines as success: true with exit code 0', { skip: process.platform === 'win32' }, async () => {
    const res = await sysRun.execute({
      command: 'echo "hello sovereign causyne" | grep -i "sovereign"'
    });

    assert.strictEqual(res.success, true);
    assert.strictEqual(res.exitCode, 0);
    assert.ok(res.output.includes('sovereign'));
  });

  test('sysRun returns cached output for repeated read-only idempotent commands', async () => {
    const cmd = 'node -v';
    const first = await sysRun.execute({ command: cmd });
    assert.strictEqual(first.success, true);
    assert.strictEqual(first.cached, undefined);

    const second = await sysRun.execute({ command: cmd });
    assert.strictEqual(second.success, true);
    assert.strictEqual(second.cached, true);
    assert.strictEqual(second.output, first.output);

    clearSysRunCache();
    const third = await sysRun.execute({ command: cmd });
    assert.strictEqual(third.success, true);
    assert.strictEqual(third.cached, undefined);
  });

  test('sysRun still fails on actual non-search errors (e.g. invalid command)', async () => {
    const res = await sysRun.execute({
      command: 'non_existent_command_xyz_87654321'
    });

    assert.strictEqual(res.success, false);
    assert.ok(res.exitCode > 0);
  });
});

describe('Universal Tool Compatibility: toolScanner Multi-Vendor Conformance', () => {
  const sampleTools = [
    {
      name: 'sysRun',
      description: 'Execute a shell command.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The shell command' },
          timeout: { type: 'number', description: 'Timeout in ms' }
        },
        required: ['command'],
        additionalProperties: false // Incompatible with Gemini
      }
    },
    {
      name: 'web_fetch',
      description: 'Fetch web content.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          headers: { type: 'object' } // Empty object, rejected by Gemini without properties
        },
        required: ['url']
      }
    },
    {
      name: 'ui_forge',
      description: 'Forge UI layouts.',
      parameters: {
        type: 'object',
        properties: {
          styleVariant: { type: ['string', 'number'] } // Union type array
        }
      }
    }
  ];

  test('Gemini adapter strips additionalProperties, rewrites empty objects, and cleans union types', () => {
    const report = scanAndAdaptToolsForProvider(sampleTools, 'gemini');
    assert.strictEqual(report.provider, 'gemini');
    assert.strictEqual(report.adaptedTools.length, 3);

    const adaptedSysRun = report.adaptedTools.find((t) => t.name === 'sysRun');
    assert.ok(adaptedSysRun);
    assert.strictEqual(adaptedSysRun.parameters.additionalProperties, undefined, 'additionalProperties must be stripped');

    const adaptedWebFetch = report.adaptedTools.find((t) => t.name === 'web_fetch');
    assert.ok(adaptedWebFetch);
    // Empty object 'headers' must be rewritten to string representation for Gemini
    assert.strictEqual(adaptedWebFetch.parameters.properties.headers.type, 'string');

    const adaptedUiForge = report.adaptedTools.find((t) => t.name === 'ui_forge');
    assert.ok(adaptedUiForge);
    // Union type array must be converted to single safe type
    assert.strictEqual(typeof adaptedUiForge.parameters.properties.styleVariant.type, 'string');
  });

  test('Anthropic adapter conforms to input_schema specification and tool name grammar', () => {
    const report = scanAndAdaptToolsForProvider(sampleTools, 'anthropic');
    assert.strictEqual(report.provider, 'anthropic');
    assert.strictEqual(report.adaptedTools.length, 3);

    for (const tool of report.adaptedTools) {
      assert.ok(/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name));
      assert.ok(tool.input_schema);
      assert.strictEqual(tool.input_schema.type, 'object');
    }
  });

  test('OpenAI adapter conforms to type: function wrapper specification', () => {
    const report = scanAndAdaptToolsForProvider(sampleTools, 'openai');
    assert.strictEqual(report.provider, 'openai');
    assert.strictEqual(report.adaptedTools.length, 3);

    for (const tool of report.adaptedTools) {
      assert.strictEqual(tool.type, 'function');
      assert.ok(tool.function.name);
      assert.ok(tool.function.parameters);
    }
  });
});

describe('Universal Tool Self-Repair: toolSelfRepair Inbound Healing Buffer', () => {
  test('recovers from markdown code fences and conversational wrapping', () => {
    const fenced = '```json\n{"command": "ls -la"}\n```';
    const res = repairJsonArguments(fenced);
    assert.strictEqual(res.repaired, true);
    assert.strictEqual(res.args.command, 'ls -la');

    const conversational = 'Here is the tool call: {"path": "/home/user/test.txt"} hope this helps!';
    const res2 = repairJsonArguments(conversational);
    assert.strictEqual(res2.repaired, true);
    assert.strictEqual(res2.args.path, '/home/user/test.txt');
  });

  test('recovers from trailing commas and single-quoted JSON', () => {
    const malformed = "{'command': 'which python3', 'cwd': '/tmp',}";
    const res = repairJsonArguments(malformed);
    assert.strictEqual(res.repaired, true);
    assert.strictEqual(res.args.command, 'which python3');
    assert.strictEqual(res.args.cwd, '/tmp');
  });

  test('recovers from unescaped newlines and unclosed braces in truncated JSON', () => {
    const truncated = '{"command": "echo line1\nline2';
    const res = repairJsonArguments(truncated);
    assert.strictEqual(res.repaired, true);
    assert.ok(res.args.command);
  });

  test('resolves hallucinated parameter aliases to canonical schema names', () => {
    const rawArgs = { cmd: 'git status', destPath: '/tmp/dest.txt' };
    const res = resolveParameterAliases('sysRun', rawArgs);
    assert.strictEqual(res.repaired, true);
    assert.strictEqual(res.args.command, 'git status');
  });

  test('coerces argument types matching schema (string to number, string to boolean)', () => {
    const schema = {
      type: 'object',
      properties: {
        timeout: { type: 'number' },
        verbose: { type: 'boolean' }
      }
    };
    const rawArgs = { timeout: '5000', verbose: 'true' };
    const res = coerceArgumentTypes('testTool', rawArgs, schema);
    assert.strictEqual(res.repaired, true);
    assert.strictEqual(res.args.timeout, 5000);
    assert.strictEqual(res.args.verbose, true);
  });

  test('canonicalizes hallucinated tool names across providers', () => {
    assert.strictEqual(canonicalizeToolName('run_command'), 'sysRun');
    assert.strictEqual(canonicalizeToolName('runCommand'), 'sysRun');
    assert.strictEqual(canonicalizeToolName('bash'), 'sysRun');
    assert.strictEqual(canonicalizeToolName('read_file'), 'fs_read');
    assert.strictEqual(canonicalizeToolName('view_file'), 'fs_read');
    assert.strictEqual(canonicalizeToolName('write_file'), 'fs_write');
  });

  test('selfRepairToolCall executes end-to-end pipeline cleanly', () => {
    const toolCall = {
      function: {
        name: 'run_command',
        arguments: '```json\n{"cmd": "npm test", "timeout": "30000"}\n```'
      }
    };
    const schema = {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeout: { type: 'number' }
      }
    };

    const repaired = selfRepairToolCall(toolCall, schema);
    assert.strictEqual(repaired.name, 'sysRun');
    assert.strictEqual(repaired.args.command, 'npm test');
    assert.strictEqual(repaired.args.timeout, 30000);
    assert.strictEqual(repaired.repaired, true);
  });
});

describe('Antigravity Native Action Mapping & Detail Fallback', () => {
  test('maps RunCommand with CommandLine into sysRun', () => {
    const mapped = mapNativeToolToCausyne('RunCommand', { CommandLine: 'python3 test.py' }, 0);
    assert.ok(mapped);
    assert.strictEqual(mapped.function.name, 'sysRun');
    assert.deepStrictEqual(JSON.parse(mapped.function.arguments), { command: 'python3 test.py' });
  });

  test('maps RunCommand using detail fallback when rawParams lacks CommandLine', () => {
    const mapped = mapNativeToolToCausyne('RunCommand', { detail: 'ls -la /home/user' }, 0);
    assert.ok(mapped);
    assert.strictEqual(mapped.function.name, 'sysRun');
    assert.deepStrictEqual(JSON.parse(mapped.function.arguments), { command: 'ls -la /home/user' });
  });

  test('formatConversation does not invent pre-verified host environment facts', () => {
    const provider = new AntigravityProvider();
    const formatted = provider.formatConversation([
      { role: 'user', content: 'create a 3js game shoting and optimized it with numpy' }
    ]);

    assert.ok(!formatted.includes('[Pre-Verified Host Environment]'));
    assert.ok(!formatted.includes('numpy (v2.4.3) are confirmed installed'));
  });

  test('formatConversation folds duplicate tool results to prevent context window explosion', () => {
    const provider = new AntigravityProvider();
    const messages = [
      { role: 'user', content: 'check environment' },
      { role: 'tool', name: 'sysRun', content: 'NumPy version: 2.4.3' },
      { role: 'tool', name: 'sysRun', content: 'NumPy version: 2.4.3' },
      { role: 'tool', name: 'sysRun', content: 'NumPy version: 2.4.3' }
    ];
    const formatted = provider.formatConversation(messages);
    const occurrences = (formatted.match(/NumPy version: 2\.4\.3/g) || []).length;
    assert.strictEqual(occurrences, 1, 'Duplicate tool results must be folded into a single entry');
  });

  test('formatConversation folds duplicate assistant tool calls to prevent pattern-matching loop inertia', () => {
    const provider = new AntigravityProvider();
    const probeCall = [{
      id: 'call_1',
      type: 'function',
      function: {
        name: 'sysRun',
        arguments: JSON.stringify({ command: 'python3 -c "import numpy; print(numpy.__version__)"' })
      }
    }];
    const messages = [
      { role: 'user', content: 'check numpy' },
      { role: 'assistant', content: '', tool_calls: probeCall },
      { role: 'assistant', content: '', tool_calls: probeCall },
      { role: 'assistant', content: '', tool_calls: probeCall }
    ];
    const formatted = provider.formatConversation(messages);
    const occurrences = (formatted.match(/import numpy/g) || []).length;
    assert.strictEqual(occurrences, 1, 'Duplicate assistant tool calls must be folded into a single entry');
  });
});
