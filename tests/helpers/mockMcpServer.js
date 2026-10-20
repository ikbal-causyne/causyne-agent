#!/usr/bin/env node
// A minimal MCP server over stdio, used to prove the client end to end.
//
// Deliberately a real committed file rather than a string written to disk at
// test time: writing an executable script from a JS literal is the dropper
// shape ZM-05 forbids, and a test fixture is not an exception worth carving.

let buffer = '';
let roots = null;
let extraToolEnabled = false;
process.stdin.setEncoding('utf-8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) handle(JSON.parse(line));
  }
});

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}

function handle(frame) {
  if (frame.id === 9001 && frame.result) {
    roots = frame.result.roots || [];
    return;
  }
  if (frame.method === 'initialize') {
    const respond = () => reply(frame.id, {
      protocolVersion: '2025-06-18',
      capabilities: {
        tools: { listChanged: true },
        resources: { listChanged: true },
        prompts: { listChanged: true }
      },
      serverInfo: { name: 'mock-mcp', version: '1.0.0' }
    });
    const delay = Number.parseInt(process.env.MOCK_MCP_INIT_DELAY_MS || '0', 10);
    if (Number.isFinite(delay) && delay > 0) return setTimeout(respond, delay);
    return respond();
  }
  if (frame.method === 'notifications/initialized') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 9001, method: 'roots/list', params: {} }) + '\n');
    return;
  }
  if (frame.method === 'tools/list') {
    return reply(frame.id, {
      tools: [
        {
          name: 'echo',
          description: 'Echo the supplied text back.',
          inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
        },
        {
          name: 'structured',
          description: 'Return structured data without text.',
          inputSchema: { type: 'object', properties: {} }
        },
        {
          name: 'roots',
          description: 'Return the roots advertised by the client.',
          inputSchema: { type: 'object', properties: {} }
        },
        {
          name: 'enable_extra',
          description: 'Add another tool and notify the client.',
          inputSchema: { type: 'object', properties: {} }
        },
        ...(extraToolEnabled ? [{
          name: 'extra',
          description: 'A dynamically added tool.',
          inputSchema: { type: 'object', properties: {} }
        }] : [])
      ]
    });
  }
  if (frame.method === 'resources/list') {
    return reply(frame.id, {
      resources: [{ uri: 'mock://note', name: 'note', description: 'A mock text resource.', mimeType: 'text/plain' }]
    });
  }
  if (frame.method === 'resources/templates/list') {
    return reply(frame.id, { resourceTemplates: [] });
  }
  if (frame.method === 'resources/read') {
    const uri = frame.params?.uri;
    return reply(frame.id, {
      contents: [{ uri, mimeType: 'text/plain', text: uri === 'mock://note' ? 'resource text' : 'unknown resource' }]
    });
  }
  if (frame.method === 'prompts/list') {
    return reply(frame.id, {
      prompts: [{ name: 'greet', description: 'Build a greeting.', arguments: [{ name: 'who', required: false }] }]
    });
  }
  if (frame.method === 'prompts/get') {
    const who = frame.params?.arguments?.who || 'world';
    return reply(frame.id, {
      description: 'Greeting prompt',
      messages: [{ role: 'user', content: { type: 'text', text: `Hello ${who}` } }]
    });
  }
  if (frame.method === 'tools/call') {
    const { name, arguments: args } = frame.params || {};
    if (name === 'echo') {
      return reply(frame.id, { content: [{ type: 'text', text: `echo: ${args?.text ?? ''}` }] });
    }
    if (name === 'structured') {
      return reply(frame.id, { content: [], structuredContent: { answer: 42, ok: true } });
    }
    if (name === 'roots') {
      return reply(frame.id, { content: [{ type: 'text', text: JSON.stringify(roots) }] });
    }
    if (name === 'enable_extra') {
      extraToolEnabled = true;
      reply(frame.id, { content: [{ type: 'text', text: 'enabled' }] });
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed', params: {} }) + '\n');
      return;
    }
    if (name === 'extra') {
      return reply(frame.id, { content: [{ type: 'text', text: 'extra works' }] });
    }
    return reply(frame.id, { isError: true, content: [{ type: 'text', text: `no such tool: ${name}` }] });
  }
  if (frame.id !== undefined) reply(frame.id, {});
}
