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
import type { ChatOptions } from '../src/providers/base.js';

test('horse-app wording selects web construction and loads its design playbook before any tool', () => {
  const prompt = 'i want you create web applicatio  tinder for horse';
  assert.equal(determineToolScope(prompt).archetype, 'web_engineering');
  const result = resolveLazyPlaybooks(['web'], [], prompt);
  assert.ok(result.activePlaybookDomains.includes('web'));
  assert.ok(result.fullPlaybooks.length > 100);
});

test('horse-run replay cannot subtract 627289 cache reads from 94500 fresh input', () => {
  assert.equal(noncachedTokens({ promptTokens: 94500, uncachedPromptTokens: 94500,
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
