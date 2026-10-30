import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AntigravityProvider } from '../src/providers/antigravity.js';
import { AgentLoop } from '../src/agentLoop.js';
import { stripThinkBlocks } from '../src/implementationPlan.js';
import { ChatRenderer } from '../src/tui/chatRenderer.js';

test('ChatRenderer shows live reasoning tail while streaming and capped head when done', () => {
  const captured: string[] = [];
  const renderer = new ChatRenderer({
    out: {
      columns: 80,
      write: (s: string) => { captured.push(s); return true; }
    }
  });

  const longReasoning = Array.from({ length: 25 }, (_, i) => `thought step ${i + 1}`).join('\n');

  // 1. Streaming in progress: should display active thinking and latest thoughts
  renderer.onAgentReasoning({
    content: longReasoning,
    delta: 'thought step 25',
    streaming: true,
    elapsedMs: 1200
  });

  const streamingText = captured.join('');
  assert.match(streamingText, /thought step 25/);
  assert.match(streamingText, /thinking…/);

  // 2. Completed frame: should display capped head and duration
  captured.length = 0;
  renderer.onAgentReasoning({
    content: longReasoning,
    streaming: false,
    elapsedMs: 2500
  });

  const doneText = captured.join('');
  assert.match(doneText, /thought step 1/);
  assert.match(doneText, /more lines of reasoning/);
  assert.match(doneText, /2\.5s/);
});

test('Antigravity streams inline think blocks to reasoning without delaying output', { skip: process.platform === 'win32' }, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-think-stream-'));
  const command = path.join(directory, 'agy');
  fs.writeFileSync(command, `#!/usr/bin/env node
const emit = event => process.stdout.write(JSON.stringify(event) + '\\n');
process.stdin.resume();
process.stdin.on('end', () => {
  emit({ event: 'init', conversation_id: 'think-stream-test' });
  emit({ event: 'step_update', step_update: { step_index: 1, state: 'ACTIVE', text_delta: '<think>Formulating execution plan</think>Here is the ' } });
  emit({ event: 'step_update', step_update: { step_index: 1, state: 'ACTIVE', text_delta: 'final result.' } });
  emit({ event: 'result', result: { status: 'SUCCESS', conversation_id: 'think-stream-test', response: '<think>Formulating execution plan</think>Here is the final result.', usage: { input_tokens: 15, output_tokens: 10 } } });
});
`, { mode: 0o755 });

  try {
    const provider = new AntigravityProvider({ command, model: 'Gemini 3.8 Flash (Low)' });
    const reasoningChunks: string[] = [];
    const textChunks: string[] = [];

    const response = await provider.chat([{ role: 'user', content: 'test thinking' }], {
      onReasoningChunk: (chunk: string) => reasoningChunks.push(chunk),
      onChunk: (chunk: string) => textChunks.push(chunk)
    });

    assert.equal(response.content, 'Here is the final result.');
    assert.ok(reasoningChunks.length > 0, 'Reasoning chunks must be routed to onReasoningChunk');
    assert.match(reasoningChunks.join(''), /Formulating execution plan/);
    assert.equal(textChunks.join(''), 'Here is the final result.');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('AgentLoop emits live agent_message prose chunks during response generation', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-loop-prose-'));
  const events: any[] = [];
  const ws = {
    readyState: 1,
    send: (raw: string) => {
      try { events.push(JSON.parse(raw)); } catch {}
    }
  };

  try {
    const loop = new AgentLoop(ws as any, 'task-prose-test', 'what is an agent', {
      workspaceRoot: directory
    });
    loop.config.provider = 'antigravity';
    loop.config.autonomyMode = 'C';

    (loop as any).initializeProvider = () => ({
      supportsVision: false,
      chat: async (_messages: any[], options: any) => {
        options.onChunk('An ');
        options.onChunk('agent is ');
        options.onChunk('autonomous software.');
        return {
          content: 'An agent is autonomous software.',
          usage: { inputTokens: 5, outputTokens: 6 }
        };
      }
    });

    await loop.run();

    const streamingMessages = events.filter(e => e.type === 'agent_message' && e.streaming === true);
    assert.ok(streamingMessages.length >= 3, 'Expected at least 3 live streaming agent_message events');
    assert.equal(streamingMessages.at(-1)?.content, 'An agent is autonomous software.');

    const finalMessages = events.filter(e => e.type === 'agent_message' && !e.streaming);
    assert.ok(finalMessages.length >= 1, 'Expected final non-streaming agent_message event');
    assert.equal(finalMessages.at(-1)?.content, 'An agent is autonomous software.');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
