import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentLoop } from '../src/agentLoop.js';
import { AcpClient } from '../src/acp/client.js';
import { AcpProvider } from '../src/providers/acp.js';
import { determineToolScope, resolveLazyPlaybooks } from '../src/smartToolsUse.js';
import { noncachedTokens } from '../src/providers/budgetEnforcer.js';
import { AntigravityProvider, mapNativeToolToCausyne } from '../src/providers/antigravity.js';
import { isOutputRecoveryRead } from '../src/outputRecovery.js';
import { causyneHome } from '../src/utils/paths.js';
import type { ChatOptions } from '../src/providers/base.js';

test('horse-app wording selects web construction and loads its design playbook before any tool', () => {
  const prompt = 'i want you create web applicatio  tinder for horse';
  assert.equal(determineToolScope(prompt).archetype, 'web_engineering');
  const result = resolveLazyPlaybooks(['web'], [], prompt);
  assert.ok(result.activePlaybookDomains.includes('web'));
  assert.ok(result.fullPlaybooks.length > 100);
  assert.notEqual(determineToolScope('Create an Android application for notes').archetype, 'web_engineering');
});

test('horse-run replay cannot subtract 627289 cache reads from 94500 fresh input', () => {
  assert.equal(noncachedTokens({ promptTokens: 94500, uncachedPromptTokens: 94500,
    completionTokens: 52810, cachedPromptTokens: 627289 }), 147310);
  assert.equal(noncachedTokens({ promptTokens: 94500,
    completionTokens: 52810, cachedPromptTokens: 627289 }), 147310);
});

for (const provider of ['openai', 'anthropic', 'gemini', 'acp/test-peer', 'pi']) {
  test(`shared turn ceiling checkpoints ${provider} without replaying or claiming completion`, async () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-efficiency-'));
    fs.writeFileSync(path.join(workspace, 'note.txt'), 'Existing evidence');
    const events: Array<{ type: string; message?: string }> = [];
    try {
      const loop = new AgentLoop({ readyState: 1, send: value => events.push(JSON.parse(value)) },
        `efficiency-${provider}`, 'Read note.txt and summarize its content', { workspaceRoot: workspace });
      let calls = 0;
      loop.initializeProvider = () => {
        loop.config.provider = provider;
        loop.config.autonomyMode = 'C';
        return {
          supportsVision: false, supportsToolSearch: () => false,
          chat: async () => {
            calls++;
            return calls === 1 ? {
              content: '', toolCalls: [{ id: 'read-note', type: 'function',
                function: { name: 'fs_read', arguments: JSON.stringify({ path: path.join(workspace, 'note.txt') }) } }],
              usage: { promptTokens: 60_000, completionTokens: 100 }
            } : { content: 'The task is complete.', usage: { promptTokens: 45_000, completionTokens: 100 } };
          }
        } as never;
      };
      await loop.run();
      assert.equal(calls, 2);
      assert.equal(events.some(e => e.type === 'task_complete'), false);
      assert.ok(events.some(e => e.type === 'budget_warning' && e.message?.includes('checkpoint')));
      assert.ok(loop.messages.some((m: { content?: string }) => typeof m.content === 'string' && m.content.includes('[Unfinished task checkpoint]')));
    } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
  });
}

test('ACP prompt usage is measured when supplied, and context occupancy is never billed as usage', async () => {
  const original = { start: AcpClient.prototype.start, newSession: AcpClient.prototype.newSession,
    prompt: AcpClient.prototype.prompt, close: AcpClient.prototype.close };
  AcpClient.prototype.start = async () => undefined as never;
  AcpClient.prototype.newSession = async () => 'measured-session';
  AcpClient.prototype.close = async () => undefined;
  AcpClient.prototype.prompt = async () => ({ text: 'Measured response', stopReason: 'end_turn',
    usage: { inputTokens: 100, outputTokens: 20, cachedReadTokens: 4000, cachedWriteTokens: 40, thoughtTokens: 10 } });
  const peer = new AcpProvider({ provider: 'acp/test-peer', command: 'unused', args: [] });
  try {
    const response = await peer.chat([{ role: 'user', content: 'Hello' }]);
    assert.equal(response.usage.measurement, 'provider_reported');
    assert.equal(response.usage.promptTokens, 4140);
    assert.equal(noncachedTokens(response.usage), 170);
  } finally { await peer.close(); Object.assign(AcpClient.prototype, original); }
});

test('native action burst is cancelled at the shared boundary and is not retried', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-native-burst-'));
  const events: Array<{ type: string; message?: string }> = [];
  try {
    const loop = new AgentLoop({ readyState: 1, send: value => events.push(JSON.parse(value)) },
      'native-burst', 'Inspect the project files', { workspaceRoot: workspace });
    let calls = 0;
    loop.initializeProvider = () => ({ supportsVision: false, supportsToolSearch: () => false,
      chat: async (_messages: unknown[], options: ChatOptions) => {
        calls++;
        for (let index = 0; index < 36; index++) options.onNativeAction?.({ id: `native-${index}`, name: 'fs_read', status: 'running' });
        assert.equal(options.signal?.aborted, true);
        const error = new Error('peer cancelled'); error.name = 'AbortError'; throw error;
      } }) as never;
    await loop.run();
    assert.equal(calls, 1);
    assert.ok(events.some(e => e.type === 'budget_warning' && e.message?.includes('35')));
    assert.equal(events.some(e => e.type === 'task_complete'), false);
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

test('native write and edit aliases map without inventing missing file content', () => {
  const write = mapNativeToolToCausyne('write_file', { path: 'app.ts', content: 'export const ready = true;' }, 0);
  assert.equal(write?.function.name, 'fs_write');
  assert.deepEqual(JSON.parse(write!.function.arguments), { path: 'app.ts', content: 'export const ready = true;' });
  assert.equal(mapNativeToolToCausyne('write_file', { path: 'app.ts' }, 0), null);
  const edit = mapNativeToolToCausyne('edit_file', { path: 'app.ts', old_string: 'true', new_string: 'false' }, 1);
  assert.equal(edit?.function.name, 'fs_edit');
  assert.equal(mapNativeToolToCausyne('edit_file', { path: 'app.ts' }, 1), null);
});

test('the actual horse-run counters trigger the peer ceiling even with final-only usage', { skip: process.platform === 'win32' }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-horse-replay-'));
  const executable = path.join(directory, 'peer');
  fs.writeFileSync(executable, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', () => {
 process.stdout.write(JSON.stringify({event:'result',result:{status:'SUCCESS',response:'Unverified draft',
 usage:{input_tokens:94500,output_tokens:52810,cache_read_tokens:627289}}}) + '\\n');
});
`, { mode: 0o755 });
  try {
    const peer = new AntigravityProvider({ command: executable });
    await assert.rejects(peer.chat([{ role: 'user', content: 'Create the horse app' }], { maxRetries: 2 }),
      (error: unknown) => {
        const checkpoint = error as { code?: string; partialUsage?: { promptTokens: number; completionTokens: number } };
        assert.equal(checkpoint.code, 'AGY_TOKEN_BUDGET');
        assert.equal(checkpoint.partialUsage?.promptTokens, 94500);
        return true;
      });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('an empty peer timeout is an explicit non-retryable failure, never completion', { skip: process.platform === 'win32' }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-peer-timeout-'));
  const executable = path.join(directory, 'peer');
  const attempts = path.join(directory, 'attempts.txt');
  fs.writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(attempts)}, 'attempt\\n');
process.stdin.resume();
process.stdin.on('end', () => {
 process.stderr.write('[agy] print timeout after 1m0s with turn in progress; returning partial output');
 process.stdout.write(JSON.stringify({event:'result',result:{status:'SUCCESS',response:'',usage:{input_tokens:0,output_tokens:0}}})+'\\n');
});`, { mode: 0o755 });
  try {
    const peer = new AntigravityProvider({ command: executable });
    await assert.rejects(peer.chat([{ role: 'user', content: 'Create a file' }], { maxRetries: 2 }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, 'PROVIDER_NO_PROGRESS');
        const loop = Object.create(AgentLoop.prototype) as AgentLoop;
        assert.equal(loop.classifyError(error), 'fatal');
        return true;
      });
    assert.equal(fs.readFileSync(attempts, 'utf8'), 'attempt\n');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('separate peer cache counters cannot bypass the fresh-token ceiling while inclusive accounting is preserved', { skip: process.platform === 'win32' }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-cache-budget-'));
  const executable = path.join(directory, 'peer');
  fs.writeFileSync(executable, `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', () => process.stdout.write(JSON.stringify({event:'result',result:{status:'SUCCESS',response:'Measured response',
 usage:{input_tokens:90000,output_tokens:100,cache_read_tokens:89000}}})+'\\n'));
`, { mode: 0o755 });
  try {
    const peer = new AntigravityProvider({ command: executable });
    // Inclusive API counters still subtract cache reads through the shared
    // helper. AGY counters are separate even when cache happens to be smaller.
    assert.equal(noncachedTokens({ promptTokens: 90000, completionTokens: 100, cachedPromptTokens: 89000 }), 1100);
    await assert.rejects(peer.chat([{ role: 'user', content: 'Hello' }], {
      maxTokensThisCall: 2000, tokenBudgetBasis: 'noncached' }),
    (error: unknown) => {
      const stopped = error as { code?: string; partialUsage?: { uncachedPromptTokens?: number } };
      assert.equal(stopped.code, 'AGY_TOKEN_BUDGET');
      assert.equal(stopped.partialUsage?.uncachedPromptTokens, 90000);
      return true;
    });
    await assert.rejects(new AntigravityProvider({ command: executable }).chat([{ role: 'user', content: 'Hello' }], {
      maxTokensThisCall: 2000, tokenBudgetBasis: 'total' }),
    (error: unknown) => (error as { code?: string }).code === 'AGY_TOKEN_BUDGET');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('ACP inference bridge denies native permission and host write requests', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-acp-bridge-'));
  const executable = path.join(directory, 'peer.cjs');
  const target = path.join(directory, 'should-not-exist.txt');
  fs.writeFileSync(executable, `const readline = require('node:readline');
const send = value => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
let promptId;
readline.createInterface({input:process.stdin}).on('line', line => {
 const req=JSON.parse(line);
 if(req.method==='initialize') send({id:req.id,result:{protocolVersion:1,agentCapabilities:{}}});
 else if(req.method==='session/new') send({id:req.id,result:{sessionId:'bridge-session'}});
 else if(req.method==='session/prompt') {
  promptId=req.id;
  send({id:'permission',method:'session/request_permission',params:{sessionId:'bridge-session',
   toolCall:{toolCallId:'native-write',title:'Write file',kind:'edit'},options:[{optionId:'allow',name:'Allow',kind:'allow_once'}]}});
 } else if(req.id==='permission') {
  send({method:'session/update',params:{sessionId:'bridge-session',update:{sessionUpdate:'agent_message_chunk',
   content:{type:'text',text:req.result.outcome.outcome}}}});
  send({id:'native-write',method:'fs/write_text_file',params:{sessionId:'bridge-session',path:${JSON.stringify(target)},content:'unsafe'}});
 } else if(req.id==='native-write') {
  send({method:'session/update',params:{sessionId:'bridge-session',update:{sessionUpdate:'agent_message_chunk',
   content:{type:'text',text:req.error?' denied':' allowed'}}}});
  send({id:promptId,result:{stopReason:'end_turn',usage:{inputTokens:30,outputTokens:4,cachedReadTokens:100}}});
 }
});`);
  const peer = new AcpProvider({ provider: 'acp/test-peer', command: process.execPath, args: [executable] });
  try {
    const response = await peer.chat([{ role: 'user', content: 'Use only Causyne tools' }], { workspaceRoot: directory });
    assert.equal(response.content, 'cancelled denied');
    assert.equal(fs.existsSync(target), false);
    assert.equal(response.usage.measurement, 'provider_reported');
    assert.equal(noncachedTokens(response.usage), 34);
  } finally { await peer.close(); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('recovery permits only a known regular output file and never widens write authority', () => {
  const directory = path.join(causyneHome(), 'tool-output', 'recovery-test');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'result.log');
  const sibling = path.join(directory, 'other.log');
  fs.writeFileSync(file, 'Saved evidence'); fs.writeFileSync(sibling, 'Other task');
  const known = new Set([file]);
  assert.equal(isOutputRecoveryRead('fs_read', file, known), true);
  assert.equal(isOutputRecoveryRead('fs_read', sibling, known), false);
  assert.equal(isOutputRecoveryRead('fs_write', file, known), false);
  assert.equal(isOutputRecoveryRead('fs_read', path.join(causyneHome(), 'credentials.json'), known), false);
});

test('a workspace-scoped run can recover its exact stored result through fs_read', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-output-recovery-'));
  fs.writeFileSync(path.join(workspace, 'evidence.txt'), Array.from({ length: 120 }, (_, index) => `Evidence ${index}: ${'x'.repeat(60)}`).join('\n'));
  const loop = new AgentLoop({ readyState: 1, send: () => {} }, 'recovery-integration',
    'Read evidence.txt and summarize the evidence', { workspaceRoot: workspace });
  let calls = 0;
  let recovered = false;
  loop.initializeProvider = () => {
    loop.config.autonomyMode = 'C';
    loop.sandbox.grantAllAccess = false;
    loop.sandbox.workspacePaths = [workspace];
    return { supportsVision: false, supportsToolSearch: () => false,
      chat: async () => {
        calls++;
        const prior = loop.messages.filter((message: { role: string }) => message.role === 'tool').at(-1);
        if (calls === 3) {
          recovered = JSON.parse(prior.content).success === true;
          return { content: 'The requested evidence was read.', usage: { promptTokens: 10, completionTokens: 5 } };
        }
        return { content: '', toolCalls: [{ id: `read-${calls}`, type: 'function', function: { name: 'fs_read',
          arguments: JSON.stringify({ path: calls === 1 ? path.join(workspace, 'evidence.txt') : prior.spillPath, startLine: 1, endLine: calls === 1 ? 120 : 3 }) } }],
          usage: { promptTokens: 10, completionTokens: 5 } };
      } } as never;
  };
  try {
    await loop.run();
    assert.equal(calls, 3);
    assert.equal(recovered, true);
    assert.deepEqual(loop.sandbox.workspacePaths, [workspace]);
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});
