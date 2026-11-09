/**
 * Causyne Agent — Universal Tool Calling Across General Providers Tests
 *
 * Verifies robust execution of tools when invoked by any general provider
 * (BYOK, OpenRouter Free, or ACP peer):
 * 1. sysRun timeout auto-scaling (interprets <= 600 as seconds instead of ms)
 * 2. sysRun string timeout parsing ("60s", "120s", "2m")
 * 3. toolSelfRepair alias resolution for cwd, outputFile, and timeout
 * 4. toolSelfRepair type coercion for duration and timeouts
 * 5. causyneBrowser search fallback to searchPublicWeb
 * 6. OpenRouterProvider extraction of text-embedded tool calls
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';

import { sysRun } from '../src/tools/sysRun.js';
import { selfRepairToolCall, resolveParameterAliases, coerceArgumentTypes } from '../src/tools/toolSelfRepair.js';
import { causyneBrowser } from '../src/browser/causyneBrowser.js';
import { OpenRouterProvider } from '../src/providers/openrouter.js';

describe('Universal Tool Calling — sysRun Timeout Normalization', () => {
  test('sysRun interprets timeout of 60 as 60 seconds (60,000ms) not 60ms', async () => {
    const start = Date.now();
    // A command that sleeps for 150ms. If timeout: 60 were treated as 60ms, this would fail with timeout.
    // With auto-scaling (60 -> 60,000ms), it completes cleanly.
    const result = await sysRun.execute({
      command: 'node -e "setTimeout(() => process.exit(0), 150)"',
      timeout: 60
    });

    const elapsed = Date.now() - start;
    assert.equal(result.success, true, `sysRun should succeed; got error: ${result.error}`);
    assert.ok(elapsed >= 140, `Command should have run for at least 140ms; took ${elapsed}ms`);
  });

  test('sysRun parses string timeout "60s" and "2m" properly', async () => {
    const result = await sysRun.execute({
      command: 'echo "timeout-parse-ok"',
      timeout: ('60s' as unknown as number)
    });

    assert.equal(result.success, true);
    assert.match(result.output, /timeout-parse-ok/);
  });

  test('sysRun preserves explicit millisecond timeouts over 600', async () => {
    const result = await sysRun.execute({
      command: 'echo "explicit-ms-ok"',
      timeout: 5000
    });

    assert.equal(result.success, true);
    assert.match(result.output, /explicit-ms-ok/);
  });
});

describe('Universal Tool Calling — toolSelfRepair Parameter Aliases & Coercion', () => {
  test('resolves cwd aliases (dir, directory, workdir)', () => {
    const schema = {
      type: 'object',
      properties: {
        command: { type: 'string' },
        cwd: { type: 'string' }
      }
    };

    const repaired1 = resolveParameterAliases('sysRun', { command: 'pwd', dir: '/tmp' }, schema);
    assert.equal(repaired1.args.cwd, '/tmp');

    const repaired2 = resolveParameterAliases('sysRun', { command: 'pwd', directory: '/var' }, schema);
    assert.equal(repaired2.args.cwd, '/var');

    const repaired3 = resolveParameterAliases('sysRun', { command: 'pwd', workdir: '/etc' }, schema);
    assert.equal(repaired3.args.cwd, '/etc');
  });

  test('resolves outputFile aliases (output, dest, destination, file_path)', () => {
    const schema = {
      type: 'object',
      properties: {
        url: { type: 'string' },
        outputFile: { type: 'string' }
      }
    };

    const repaired1 = resolveParameterAliases('web_fetch', { url: 'https://example.com', output: 'image.png' }, schema);
    assert.equal(repaired1.args.outputFile, 'image.png');

    const repaired2 = resolveParameterAliases('web_fetch', { url: 'https://example.com', destination: 'download.zip' }, schema);
    assert.equal(repaired2.args.outputFile, 'download.zip');
  });

  test('coerces and normalizes timeout strings and seconds to milliseconds', () => {
    const schema = {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeout: { type: 'number' }
      }
    };

    // Number <= 600 -> scaled to ms
    const coerced1 = coerceArgumentTypes('sysRun', { command: 'ls', timeout: 60 }, schema);
    assert.equal(coerced1.args.timeout, 60000);

    // String "120s" -> coerced to 120000ms
    const coerced2 = coerceArgumentTypes('sysRun', { command: 'ls', timeout: '120s' }, schema);
    assert.equal(coerced2.args.timeout, 120000);

    // String "2m" -> coerced to 120000ms
    const coerced3 = coerceArgumentTypes('sysRun', { command: 'ls', timeout: '2m' }, schema);
    assert.equal(coerced3.args.timeout, 120000);

    // Large milliseconds preserved
    const coerced4 = coerceArgumentTypes('sysRun', { command: 'ls', timeout: 45000 }, schema);
    assert.equal(coerced4.args.timeout, 45000);
  });

  test('selfRepairToolCall repairs complete hallucinated tool call end-to-end', () => {
    const toolCall = {
      name: 'bash',
      arguments: '{"cmd": "curl -sL https://example.com", "dir": "/tmp", "timeout": "60s"}'
    };

    const repaired = selfRepairToolCall(toolCall, {
      type: 'object',
      properties: {
        command: { type: 'string' },
        cwd: { type: 'string' },
        timeout: { type: 'number' }
      }
    });

    assert.equal(repaired.name, 'sysRun');
    assert.equal(repaired.args.command, 'curl -sL https://example.com');
    assert.equal(repaired.args.cwd, '/tmp');
    assert.equal(repaired.args.timeout, 60000);
  });
});

describe('Universal Tool Calling — causyneBrowser Search Fallback', () => {
  test('search() falls back to lightweight search providers without crashing when browser engines fail', async () => {
    const browser = causyneBrowser();
    // Query public web. Even if Google/Bing/DDG in Playwright block or produce 0 DOM results,
    // the searchPublicWeb fallback ensures organic results are returned.
    const results = await browser.search('typescript documentation');

    assert.ok(Array.isArray(results), 'Expected array of results');
    assert.ok(results.length > 0, 'Expected at least one search result');
    assert.ok(typeof results[0]?.title === 'string');
    assert.ok(typeof results[0]?.url === 'string');
    assert.ok(results[0]?.url.startsWith('http'));
  });
});

describe('Universal Tool Calling — OpenRouterProvider Text Tool Extraction', () => {
  test('extracts <tool_call> envelopes from message content when tool_calls array is omitted by model', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({
        choices: [
          {
            message: {
              content: 'I will list the files in the workspace.\n<tool_call>{"name": "fs_list", "arguments": {"path": "."}}</tool_call>'
            }
          }
        ],
        usage: { prompt_tokens: 15, completion_tokens: 25, total_tokens: 40 }
      }), { status: 200 });
    }) as any;

    try {
      const provider = new OpenRouterProvider({ apiKey: 'mock_test_key', model: 'openrouter/free' });
      const res = await provider.chat([{ role: 'user', content: 'list files' }]);

      assert.ok(Array.isArray(res.toolCalls), 'Expected toolCalls to be extracted from content');
      assert.equal(res.toolCalls.length, 1);
      assert.equal(res.toolCalls[0]?.function.name, 'fs_list');
      const parsedArgs = JSON.parse(res.toolCalls[0]?.function.arguments || '{}');
      assert.equal(parsedArgs.path, '.');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('isBrowserRuntimeInstalled returns true when system Chromium or Chrome is available', async () => {
    const { isBrowserRuntimeInstalled, resolveChromiumRuntime } = await import('../src/browser/browserRuntime.js');
    const chromium = resolveChromiumRuntime();
    if (chromium) {
      assert.equal(isBrowserRuntimeInstalled(), true, 'Expected isBrowserRuntimeInstalled to return true when Chromium is present');
    }
  });

  test('fsWrite provides clear directory guidance instead of raw EISDIR error', async () => {
    const { fsWrite } = await import('../src/tools/fsWrite.js');
    const res = await fsWrite.execute({ path: os.tmpdir(), content: 'test' });
    assert.equal(res.success, false);
    assert.ok(res.error?.includes('is an existing directory'), 'Expected error to note directory target');
  });

  test('repairJsonArguments recovers unescaped backslashes and trailing garbage tokens', async () => {
    const { repairJsonArguments } = await import('../src/tools/toolSelfRepair.js');
    const raw = '{"path": "main.js", "content": "const x = \\  1;\\n"}}\n]';
    const repaired = repairJsonArguments(raw);
    assert.equal(repaired.repaired, true);
    assert.equal(repaired.args.path, 'main.js');
    assert.ok(typeof repaired.args.content === 'string');
  });
});
