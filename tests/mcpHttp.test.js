import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';

import { McpServer } from '@modelcontextprotocol/server';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { z } from 'zod';

import { McpClient, McpConnectionError } from '../src/mcp/mcpClient.js';

const open = [];

after(async () => {
  await Promise.allSettled(open.splice(0).map(item => item()));
});

async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  open.push(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${address.port}/mcp`;
}

describe('MCP Streamable HTTP interoperability', () => {
  test('negotiates a real session and calls a tool through the official server transport', async () => {
    const server = new McpServer({ name: 'causyne-http-fixture', version: '1.0.0' });
    server.registerTool(
      'echo',
      { description: 'Echo text.', inputSchema: { text: z.string() } },
      async ({ text }) => ({ content: [{ type: 'text', text: `http: ${text}` }] })
    );
    const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
    await server.connect(transport);
    open.push(async () => transport.close());
    const url = await listen((request, response) => { void transport.handleRequest(request, response); });

    const client = await new McpClient({ name: 'remote', url }).connect();
    open.push(async () => client.close());

    assert.equal(client.status.state, 'connected');
    assert.equal(client.status.transport, 'streamable-http');
    assert.equal(client.serverInfo?.name, 'causyne-http-fixture');
    assert.deepEqual(client.tools.map(tool => tool.name), ['echo']);
    assert.deepEqual(await client.callTool('echo', { text: 'works' }), {
      success: true,
      output: 'http: works'
    });
  });

  test('reports an authentication state instead of hiding HTTP 401 as a generic failure', async () => {
    const url = await listen((_request, response) => {
      response.writeHead(401, {
        'content-type': 'application/json',
        'www-authenticate': 'Bearer resource_metadata="https://example.test/.well-known/oauth-protected-resource"'
      });
      response.end(JSON.stringify({ error: 'unauthorized' }));
    });
    const client = new McpClient({ name: 'auth', url, timeoutMs: 2_000 });

    await assert.rejects(
      client.connect(),
      error => error instanceof McpConnectionError && error.state === 'needs_auth'
    );
    assert.equal(client.status.state, 'needs_auth');
  });
});
