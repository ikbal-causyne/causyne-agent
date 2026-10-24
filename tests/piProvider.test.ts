import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PiProvider, isPiProvider } from '../src/providers/pi.js';
import { createProvider } from '../src/providers/factory.js';

test('Pi provider uses RPC without native tools and streams code through Causyne', { skip: process.platform === 'win32' }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-pi-rpc-'));
  const fake = path.join(dir, 'pi');
  fs.writeFileSync(fake, `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync('argv.json', JSON.stringify(process.argv.slice(2)));
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  input += chunk;
  const send = record => process.stdout.write(JSON.stringify(record) + '\\n');
  let end;
  while ((end = input.indexOf('\\n')) >= 0) {
  const request = JSON.parse(input.slice(0, end));
  input = input.slice(end + 1);
  if (request.type === 'get_state') {
    send({type:'response',id:request.id,command:'get_state',success:true,data:{model:{provider:'fake',id:'test'}}});
    continue;
  }
  fs.writeFileSync('prompt.json', JSON.stringify(request));
  send({type:'response', id:request.id, command:'prompt', success:true, data:{disposition:'started'}});
  send({type:'message_update', assistantMessageEvent:{type:'thinking_delta', delta:'Need a file'}});
  send({type:'message_update', assistantMessageEvent:{type:'text_delta', delta:'<tool_call>{"name":"fs_write","arguments":{"path":"app.ts","content":"const x = 1;"}}</tool_call>'}});
  send({type:'message_end', message:{role:'assistant',content:[{type:'text',text:'<tool_call>{"name":"fs_write","arguments":{"path":"app.ts","content":"const x = 1;"}}</tool_call>'}],stopReason:'toolUse',usage:{input:12,output:5,cacheRead:2}}});
  send({type:'agent_settled',aborted:false});
  }
});
`, { mode: 0o755 });
  try {
    const provider = createProvider({ provider: 'pi', command: fake });
    assert.ok(provider instanceof PiProvider);
    assert.ok(isPiProvider('PI'));
    const chunks: string[] = [];
    const thoughts: string[] = [];
    const response = await provider.chat([{ role: 'user', content: 'create app.ts' }], {
      workspaceRoot: dir,
      onChunk: chunk => chunks.push(chunk),
      onReasoningChunk: chunk => thoughts.push(chunk)
    });
    assert.equal(response.toolCalls?.[0]?.function.name, 'fs_write');
    assert.equal(JSON.parse(response.toolCalls?.[0]?.function.arguments || '{}').content, 'const x = 1;');
    assert.equal(response.content, '');
    assert.equal(response.usage.promptTokens, 12);
    assert.equal(response.usage.cachedPromptTokens, 2);
    assert.equal(thoughts.join(''), 'Need a file');
    assert.match(chunks.join(''), /fs_write/);
    const args = JSON.parse(fs.readFileSync(path.join(dir, 'argv.json'), 'utf8')) as string[];
    assert.ok(args.includes('--mode') && args.includes('rpc'));
    assert.ok(args.includes('--no-tools'));
    assert.ok(args.includes('--no-mcp'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'prompt.json'), 'utf8')).type, 'prompt');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
