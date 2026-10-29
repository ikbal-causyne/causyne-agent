import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentLoop } from '../src/agentLoop.js';
import { resolveTool } from '../src/tools/registry.js';

test('host dispatcher rejects invalid media calls before the executor for every transport', async () => {
  const originalDirectory = process.cwd();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-host-contract-'));
  const tool = resolveTool('generate_media_via_api');
  const original = tool.execute;
  let executions = 0;
  tool.execute = async () => { executions++; return { success: true }; };
  process.chdir(directory);
  try {
    for (const provider of ['antigravity', 'acp/test', 'pi', 'openai', 'anthropic', 'gemini']) {
      const loop = new AgentLoop({ readyState: 1, send() {} }, `contract-${provider}`, 'Generate an image.', { workspaceRoot: directory });
      loop.config.provider = provider;
      let calls = 0;
      loop.initializeProvider = () => ({
        supportsVision: false, supportsToolSearch: () => false,
        chat: async () => {
          if (++calls > 1) { loop.abort(); return { content: '', usage: { promptTokens: 1, completionTokens: 1 } }; }
          return { content: '', toolCalls: [{ id: 'invalid-media', type: 'function', function: { name: 'generate_media_via_api', arguments: '{}' } }], usage: { promptTokens: 1, completionTokens: 1 } };
        }
      }) as never;
      await loop.run();
      const validation = loop.messages.find((message: { role: string; content: string }) => message.role === 'tool' && String(message.content).includes('INVALID_TOOL_ARGUMENTS'));
      assert.ok(validation, `${provider}: schema diagnostic not returned`);
      assert.match(String(validation.content), /expectedSchema/);
    }
    assert.equal(executions, 0);
  } finally { tool.execute = original; process.chdir(originalDirectory); fs.rmSync(directory, { recursive: true, force: true }); }
});

test('reasoning-only recovery is limited to one safe continuation and preserves spent usage', async () => {
  const originalDirectory = process.cwd();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-recovery-bound-'));
  process.chdir(directory);
  try {
    const events: Array<{ type: string; message?: string }> = [];
    const loop = new AgentLoop({ readyState: 1, send: (payload: string) => events.push(JSON.parse(payload)) }, 'reasoning-bound', 'Generate an image.', { workspaceRoot: directory });
    let calls = 0;
    loop.initializeProvider = () => ({
      supportsVision: false, supportsToolSearch: () => false,
      chat: async () => {
        calls++;
        throw Object.assign(new Error('No executable response'), { code: 'PROVIDER_REASONING_ONLY', continuationSafe: true, partialUsage: { promptTokens: 100, completionTokens: 20 } });
      }
    }) as never;
    await loop.run();
    assert.equal(calls, 2);
    assert.equal(loop.tokenTracker.taskTokens, 240);
    assert.equal(events.filter(event => event.type === 'notice' && event.message?.includes('continuing once')).length, 1);
    assert.equal(events.some(event => event.type === 'task_complete'), false);
  } finally { process.chdir(originalDirectory); fs.rmSync(directory, { recursive: true, force: true }); }
});
