#!/usr/bin/env node
// A minimal MCP server over stdio, used to prove the client end to end.
//
// Deliberately a real committed file rather than a string written to disk at
// test time: writing an executable script from a JS literal is the dropper
// shape ZM-05 forbids, and a test fixture is not an exception worth carving.

let buffer = '';
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
  if (frame.method === 'initialize') {
    return reply(frame.id, {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'mock-mcp', version: '1.0.0' }
    });
  }
  if (frame.method === 'tools/list') {
    return reply(frame.id, {
      tools: [
        {
          name: 'echo',
          description: 'Echo the supplied text back.',
          inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
        },
        // Malformed on purpose: the client must drop it rather than advertise a
        // tool it cannot dispatch.
        { description: 'nameless tool' }
      ]
    });
  }
  if (frame.method === 'tools/call') {
    const { name, arguments: args } = frame.params || {};
    if (name === 'echo') {
      return reply(frame.id, { content: [{ type: 'text', text: `echo: ${args?.text ?? ''}` }] });
    }
    return reply(frame.id, { isError: true, content: [{ type: 'text', text: `no such tool: ${name}` }] });
  }
  if (frame.id !== undefined) reply(frame.id, {});
}
