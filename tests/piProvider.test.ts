import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PiProvider, isPiProvider } from '../src/providers/pi.js';
import { createProvider } from '../src/providers/factory.js';

test('Pi provider preserves native capabilities and streams Causyne calls over RPC', { skip: process.platform === 'win32' }, async () => {
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
  send({type:'message_end',message:{role:'assistant',content:[],stopReason:'toolUse',usage:{input:4,output:2,cacheRead:1}}});
  send({type:'tool_execution_start',toolCallId:'native-write',toolName:'write',args:{path:'native.txt',content:'NATIVE'}});
  fs.writeFileSync('native.txt','NATIVE');
  send({type:'tool_execution_end',toolCallId:'native-write',toolName:'write',isError:false});
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
    const actions: string[] = [];
    const response = await provider.chat([{ role: 'user', content: 'create app.ts' }], {
      workspaceRoot: dir,
      onChunk: chunk => chunks.push(chunk),
      onReasoningChunk: chunk => thoughts.push(chunk),
      onNativeAction: action => actions.push(action.status)
    });
    assert.equal(response.toolCalls?.[0]?.function.name, 'fs_write');
    assert.equal(JSON.parse(response.toolCalls?.[0]?.function.arguments || '{}').content, 'const x = 1;');
    assert.equal(response.content, '');
    assert.equal(response.usage.promptTokens, 16);
    assert.equal(response.usage.completionTokens, 7);
    assert.equal(response.usage.cachedPromptTokens, 3);
    assert.deepEqual(actions, ['running', 'completed']);
    assert.equal(response.externalActions?.[0]?.name, 'write');
    assert.equal(fs.readFileSync(path.join(dir, 'native.txt'), 'utf8'), 'NATIVE');
    assert.equal(thoughts.join(''), 'Need a file');
    assert.match(chunks.join(''), /fs_write/);
    const args = JSON.parse(fs.readFileSync(path.join(dir, 'argv.json'), 'utf8')) as string[];
    assert.ok(args.includes('--mode') && args.includes('rpc'));
    for (const flag of ['--no-tools', '--no-mcp', '--no-extensions', '--no-context-files', '--no-skills', '--no-prompt-templates']) assert.ok(!args.includes(flag), flag);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'prompt.json'), 'utf8')).type, 'prompt');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
