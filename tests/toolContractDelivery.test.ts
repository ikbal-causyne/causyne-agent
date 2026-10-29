import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AcpProvider } from '../src/providers/acp.js';
import { AntigravityProvider } from '../src/providers/antigravity.js';
import { formatToolContracts, toolContractUpdate } from '../src/providers/toolContracts.js';
import { deferredMcpSearch } from '../src/tools/deferredMcpSearch.js';
import { validateToolArguments } from '../src/tools/argumentValidation.js';

const media = { name: 'generate_media_via_api', description: 'Generate an image.', parameters: {
  type: 'object', properties: { mediaType: { type: 'string', enum: ['image'] }, prompt: { type: 'string' } },
  required: ['mediaType', 'prompt']
} };

test('text bridges preserve required fields, enums, and nested contracts', () => {
  for (const tool of [media, { type: 'function', function: media }, { ...media, parameters: undefined, input_schema: media.parameters }]) {
    assert.deepEqual(JSON.parse(formatToolContracts([tool])).parameters, media.parameters);
  }
  for (const provider of [new AcpProvider(), new AntigravityProvider()]) {
    assert.match(provider.formatConversation([], [media]), /"required":\["mediaType","prompt"\]/);
  }
  const blocks = new AcpProvider().formatPromptBlocks([], [media]);
  assert.match(blocks[0].text, /"enum":\["image"\]/);
  assert.equal(toolContractUpdate([media], [media]), '');
  assert.match(toolContractUpdate([], [media]), /\[\]/);
});

test('exact discovery reveals one tool without expanding its whole capability pack', async () => {
  const result = await deferredMcpSearch.execute({ query: media.name });
  assert.equal(result.success, true);
  assert.deepEqual(result._unlock_tools, [media.name]);
  assert.deepEqual(result._unlock_packs, []);
  const pack = await deferredMcpSearch.execute({ query: '', pack: 'web' });
  assert.deepEqual(pack._unlock_packs, ['web'], 'explicit pack loading remains supported');
});

test('canonical argument validation rejects absent, mistyped, and invalid nested arguments', () => {
  assert.match(validateToolArguments({}, media.parameters).join(';'), /mediaType is required.*prompt is required/);
  assert.match(validateToolArguments({ mediaType: 'video', prompt: 42 }, media.parameters).join(';'), /one of.*must be string/);
  const schema = { type: 'object', properties: { actions: { type: 'array', items: { type: 'object', required: ['action'], properties: { action: { type: 'string' } } } } } };
  assert.match(validateToolArguments({ actions: [{}] }, schema).join(';'), /actions\[0\].action is required/);
  assert.deepEqual(validateToolArguments({ arbitrary: { nested: true } }, { type: 'object' }), []);
  assert.deepEqual(validateToolArguments(null, { type: ['object', 'null'] }), []);
});

test('resumed Antigravity receives discovered schemas and changed instructions only once', { skip: process.platform === 'win32' }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-contract-delivery-'));
  const command = path.join(directory, 'peer');
  const log = path.join(directory, 'prompts.jsonl');
  fs.writeFileSync(command, `#!/usr/bin/env node
const fs = require('fs'); let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(input) + '\\n');
  process.stdout.write(JSON.stringify({event:'init',conversation_id:'contract-session'})+'\\n');
  process.stdout.write(JSON.stringify({event:'result', result:{status:'SUCCESS',conversation_id:'contract-session',response:'Ready.',usage:{input_tokens:100,output_tokens:5}}})+'\\n');
});`, { mode: 0o755 });
  try {
    const provider = new AntigravityProvider({ command });
    const messages = [{ role: 'system', content: 'Original scope.' }, { role: 'user', content: 'Use the requested capability.' }];
    await provider.chat(messages, { conversationId: 'contract-test', tools: [] });
    messages.push({ role: 'assistant', content: 'Ready.' }, { role: 'system', content: 'New design requirement.' }, { role: 'tool', content: 'Tool discovered.' });
    await provider.chat(messages, { conversationId: 'contract-test', tools: [media] });
    messages.push({ role: 'assistant', content: 'Ready.' }, { role: 'user', content: 'Continue.' });
    await provider.chat(messages, { conversationId: 'contract-test', tools: [media] });
    const prompts = fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(JSON.parse(line)).message.content as string);
    assert.match(prompts[1]!, /"required":\["mediaType","prompt"\]/);
    assert.equal(prompts[1]!.split('New design requirement.').length - 1, 1);
    assert.doesNotMatch(prompts[2]!, /"parameters"|New design requirement/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('reasoning-only failure preserves usage for continuation without executing thought text', { skip: process.platform === 'win32' }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-reasoning-only-'));
  const command = path.join(directory, 'peer');
  fs.writeFileSync(command, `#!/usr/bin/env node
const emit = event => process.stdout.write(JSON.stringify(event)+'\\n');
process.stdin.resume(); process.stdin.on('end', () => {
  const resumed = process.argv.includes('--conversation');
  emit({event:'init',conversation_id:'reasoning-session'});
  if (!resumed) emit({event:'step_update',step_update:{step_type:'agent_thought',text_delta:'Draft: write code, but this is not an action.'}});
  emit({event:'result',result:{status:'SUCCESS',conversation_id:'reasoning-session',response:resumed ? 'Blocked: no generation key.' : '',usage:resumed ? {input_tokens:120,output_tokens:40} : {input_tokens:100,output_tokens:30}}});
});`, { mode: 0o755 });
  try {
    const provider = new AntigravityProvider({ command });
    await assert.rejects(provider.chat([{ role: 'user', content: 'Generate an image.' }], { conversationId: 'reasoning-test' }), (error: unknown) => {
      const value = error as { code: string; continuationSafe: boolean; partialUsage: { promptTokens: number; completionTokens: number } };
      assert.equal(value.code, 'PROVIDER_REASONING_ONLY');
      assert.equal(value.continuationSafe, true);
      assert.equal(value.partialUsage.promptTokens, 100);
      assert.equal(value.partialUsage.completionTokens, 30);
      return true;
    });
    const next = await provider.chat([{ role: 'user', content: 'Generate an image.' }, { role: 'assistant', content: '' }, { role: 'user', content: 'Report the blocker.' }], { conversationId: 'reasoning-test' });
    assert.equal(next.usage.promptTokens, 20);
    assert.equal(next.usage.completionTokens, 10);
    assert.equal(next.toolCalls?.length || 0, 0);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
