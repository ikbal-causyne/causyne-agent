import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import { McpServer } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { z } from 'zod';

import {
  MAX_GLOB_PATTERN_CHARS,
  MAX_MCP_TOOL_DESCRIPTION_CHARS,
  MAX_TOOLS_PER_MCP_SERVER,
  globMatchesSafe,
  sanitizeMcpInputSchema,
  sanitizeMcpMetadataText,
  sanitizeMcpToolName,
  stripInvisibleAndBidi
} from '../src/mcp/mcpSecurity.js';
import { McpClient } from '../src/mcp/mcpClient.js';

const open: Array<() => Promise<unknown>> = [];

after(async () => {
  await Promise.allSettled(open.splice(0).map(item => item()));
});

async function listen(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  open.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  return `http://127.0.0.1:${address.port}/mcp`;
}

describe('Sector 4 — ReDoS-free iterative MCP glob matching (CWE-1333)', () => {
  test('matches exact names, wildcards, single-char ?, consecutive stars, and Unicode surrogate pairs', () => {
    assert.equal(globMatchesSafe('read_file', 'read_*'), true);
    assert.equal(globMatchesSafe('read_file', '*_file'), true);
    assert.equal(globMatchesSafe('read_file', 'read_????'), true);
    assert.equal(globMatchesSafe('read_file', 'read_???'), false);
    assert.equal(globMatchesSafe('read_file', '****read****file****'), true);
    assert.equal(globMatchesSafe('tool_🔥_run', 'tool_?_run'), true);
    assert.equal(globMatchesSafe('a.b+c(d)[e]', 'a.b+c(d)[e]'), true);
    assert.equal(globMatchesSafe('anything', '*'), true);
    assert.equal(globMatchesSafe('', ''), true);
    assert.equal(globMatchesSafe('', '*'), true);
    assert.equal(globMatchesSafe('', '?'), false);
  });

  test('evaluates adversarial backtracking patterns in linear time (< 50ms) and enforces pattern length bound', () => {
    const evilPattern = '*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*a*b';
    const evilInput = 'a'.repeat(500);

    const start = performance.now();
    const matched = globMatchesSafe(evilInput, evilPattern);
    const elapsedMs = performance.now() - start;

    assert.equal(matched, false);
    assert.ok(elapsedMs < 50, `Adversarial glob took ${elapsedMs.toFixed(2)}ms; must stay linear-time`);

    assert.equal(globMatchesSafe('abc', 'a'.repeat(MAX_GLOB_PATTERN_CHARS + 1)), false);
  });

  test('McpClient.validateDefinition rejects oversized tools.include / tools.exclude patterns', () => {
    const tooLong = 'a'.repeat(MAX_GLOB_PATTERN_CHARS + 1);
    const err = McpClient.validateDefinition({
      name: 'bounded',
      command: 'node',
      tools: { include: [tooLong] }
    });
    assert.ok(err && err.includes('at most'), `Expected pattern length rejection, got: ${err}`);
  });
});

describe('Sector 4 — Untrusted MCP metadata sanitization & schema bounds', () => {
  test('strips ANSI escape sequences and Unicode bidi/zero-width Trojan Source characters', () => {
    const poisoned = '\x1b[2J\x1b]0;PWNED\x07Hello \u202eWorld\u2066\u200b\ufeff!';
    const cleaned = sanitizeMcpMetadataText(poisoned, 200);
    assert.doesNotMatch(cleaned, /\x1b/);
    assert.doesNotMatch(cleaned, /[\u202e\u2066\u200b\ufeff]/);
    assert.equal(cleaned, 'Hello World!');
    assert.equal(stripInvisibleAndBidi('ab\u202ecd\u2069ef'), 'abcdef');
  });

  test('truncates oversized tool descriptions cleanly at ceiling', () => {
    const huge = 'X'.repeat(MAX_MCP_TOOL_DESCRIPTION_CHARS + 500);
    const cleaned = sanitizeMcpMetadataText(huge, MAX_MCP_TOOL_DESCRIPTION_CHARS);
    assert.ok(cleaned.length <= MAX_MCP_TOOL_DESCRIPTION_CHARS);
    assert.ok(cleaned.endsWith('… [truncated]'));
  });

  test('sanitizeMcpToolName rejects control chars, NUL bytes, empty, and oversized names', () => {
    assert.equal(sanitizeMcpToolName('valid_tool-1'), 'valid_tool-1');
    assert.equal(sanitizeMcpToolName('bad\x00name'), null);
    assert.equal(sanitizeMcpToolName('bad\x1bname'), null);
    assert.equal(sanitizeMcpToolName('   '), null);
    assert.equal(sanitizeMcpToolName('x'.repeat(200)), null);
  });

  test('sanitizeMcpInputSchema bounds nesting depth, strips schema poisoning, drops __proto__, and caps byte size', () => {
    // 1. Prototype pollution + nested ANSI/bidi inside property description
    const dirty: Record<string, unknown> = JSON.parse(
      '{"type":"object","__proto__":{"polluted":true},"properties":{"q":{"type":"string","description":"\\u001b[31mRed\\u001b[0m\\u202eHidden"}}}'
    );
    const clean = sanitizeMcpInputSchema(dirty);
    assert.equal(Object.prototype.hasOwnProperty.call(clean, '__proto__'), false);
    const props = clean.properties as Record<string, Record<string, unknown>>;
    assert.equal(props.q?.description, 'RedHidden');

    // 2. Deep nesting bomb (> 16 levels)
    let deep: Record<string, unknown> = { type: 'string' };
    for (let i = 0; i < 30; i++) {
      deep = { type: 'object', properties: { child: deep } };
    }
    const boundedDeep = sanitizeMcpInputSchema(deep);
    assert.ok(JSON.stringify(boundedDeep).includes('Nested schema truncated'));

    // 3. Size bomb (> 64 KiB)
    const bigProps: Record<string, unknown> = {};
    for (let i = 0; i < 150; i++) {
      bigProps[`field_${i}`] = { type: 'string', description: 'A'.repeat(700) };
    }
    const boundedSize = sanitizeMcpInputSchema({ type: 'object', properties: bigProps });
    assert.match(String(boundedSize.description), /64 KiB safety limit/);
  });

  test('live McpClient caps tools per server at 256 and sanitizes poisoned descriptions end-to-end', async () => {
    const server = new McpServer({ name: 'flood-fixture', version: '1.0.0' });
    server.registerTool(
      'poisoned',
      {
        description: '\x1b[2J\x1b]0;HIJACK\x07Safe\u202e text ' + 'Z'.repeat(3000),
        inputSchema: { text: z.string().describe('\x1b[31mArg\u200b desc\x1b[0m') }
      },
      async ({ text }) => ({ content: [{ type: 'text', text }] })
    );
    for (let i = 0; i < MAX_TOOLS_PER_MCP_SERVER + 30; i++) {
      server.registerTool(
        `bulk_${i}`,
        { description: `Tool ${i}`, inputSchema: { x: z.string().optional() } },
        async () => ({ content: [{ type: 'text', text: 'ok' }] })
      );
    }

    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
    await server.connect(transport);
    open.push(async () => transport.close());
    const url = await listen((req, res) => { void transport.handleRequest(req, res); });

    const client = await new McpClient({ name: 'flood', url }).connect();
    open.push(async () => client.close());

    assert.equal(client.tools.length, MAX_TOOLS_PER_MCP_SERVER, 'tools per server must be capped at 256');
    const poisoned = client.tools.find(t => t.name === 'poisoned');
    assert.ok(poisoned, 'poisoned tool should be present');
    assert.doesNotMatch(poisoned.description, /\x1b/);
    assert.doesNotMatch(poisoned.description, /\u202e/);
    assert.ok(poisoned.description.length <= MAX_MCP_TOOL_DESCRIPTION_CHARS);
    assert.ok(poisoned.description.startsWith('Safe text '));
    assert.ok(poisoned.description.endsWith('… [truncated]'));
  });
});
