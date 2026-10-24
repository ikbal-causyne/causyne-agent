import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentLoop } from '../src/agentLoop.js';

test('an actionable request fails visibly after repeated greetings without showing them as answers', async () => {
  const previousDirectory = process.cwd();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-greeting-'));
  fs.writeFileSync(path.join(workspace, 'package.json'), '{}');
  process.chdir(workspace);

  try {
    const events: Array<{ type: string; message?: string }> = [];
    const loop = new AgentLoop({ readyState: 1, send: (payload: string) => events.push(JSON.parse(payload)) }, 'greeting-regression', 'create a 3js shooting game');
    let calls = 0;
    const model = {
      supportsVision: false,
      supportsToolSearch: () => false,
      chat: async () => {
        calls += 1;
        return { content: 'Hello! How can I help you today?', usage: { promptTokens: 10, completionTokens: 8 } };
      }
    };
    loop.initializeProvider = () => model as never;

    await loop.run();

    assert.equal(calls, 3);
    assert.equal(events.some((event) => event.type === 'agent_message'), false);
    assert.equal(events.some((event) => event.type === 'error' && event.message?.includes('No work was completed')), true);
    assert.equal(loop.unlockedPacks.has('game'), false);
  } finally {
    process.chdir(previousDirectory);
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('planning-only responses cannot report an unstarted task as complete', async () => {
  const previousDirectory = process.cwd();
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-no-progress-'));
  fs.writeFileSync(path.join(workspace, 'package.json'), '{}');
  process.chdir(workspace);

  try {
    const events: Array<{ type: string; message?: string }> = [];
    const loop = new AgentLoop({ readyState: 1, send: (payload: string) => events.push(JSON.parse(payload)) }, 'planning-regression', 'create a 3js shooting game');
    const model = {
      supportsVision: false,
      supportsToolSearch: () => false,
      chat: async () => ({ content: 'I will create the game next.', usage: { promptTokens: 10, completionTokens: 8 } })
    };
    loop.initializeProvider = () => model as never;

    await loop.run();

    assert.equal(events.some((event) => event.type === 'agent_message'), false);
    assert.equal(events.some((event) => event.type === 'error' && event.message?.includes('No work was completed')), true);
    assert.equal(events.some((event) => event.type === 'status' && event.message === 'Task completed.'), false);
  } finally {
    process.chdir(previousDirectory);
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
