import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  createSession,
  saveSessionMessages,
  deleteSession,
  forkSession,
  getSession,
  listSessions
} from '../src/sessionStore.js';
import {
  grantAlways,
  isAlwaysAllowed,
  listAlwaysAllowed,
  revokeAllAlways,
  createApprovalScope
} from '../src/approvalGrants.js';
import { AgentLoop } from '../src/agentLoop.js';
import { MemoryManager } from '../src/memoryManager.js';
import { runCommand, handleInput } from '../src/commands.js';

const tempWorkspace = () => fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-fork-test-'));

test('forkSession: copies conversation history into a new session record', () => {
  const ws = tempWorkspace();
  try {
    const parent = createSession(ws, 'Parent Architecture Plan', true);
    saveSessionMessages(parent.id, [
      { role: 'user', content: 'Design Three.js game architecture' },
      { role: 'assistant', content: 'Here is the scene graph structure...' },
      { role: 'user', content: 'Add shader optimizations' }
    ]);

    const forked = forkSession(parent.id);
    assert.ok(forked, 'Forked session must exist');
    assert.notEqual(forked.id, parent.id, 'Forked session must have a distinct unique ID');
    assert.equal(forked.title, 'Fork of Parent Architecture Plan');
    assert.equal(forked.workspace, ws);
    assert.equal(forked.messages.length, 3, 'All messages must be copied');
    assert.equal(forked.messages[0].content, 'Design Three.js game architecture');

    // Mutations on the forked session do not affect the parent
    saveSessionMessages(forked.id, [
      ...forked.messages,
      { role: 'assistant', content: 'Custom WebGL shaders added.' }
    ]);

    const refreshedParent = getSession(parent.id);
    const refreshedFork = getSession(forked.id);
    assert.equal(refreshedParent?.messages.length, 3, 'Parent messages must remain untouched');
    assert.equal(refreshedFork?.messages.length, 4, 'Forked messages updated independently');

    deleteSession(parent.id);
    deleteSession(forked.id);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('forkSession: supports upToMessageIndex turn slicing', () => {
  const ws = tempWorkspace();
  try {
    const parent = createSession(ws, 'Multi-turn Session', true);
    saveSessionMessages(parent.id, [
      { role: 'user', content: 'step 1' },
      { role: 'assistant', content: 'ack 1' },
      { role: 'user', content: 'step 2' },
      { role: 'assistant', content: 'ack 2' }
    ]);

    const forked = forkSession(parent.id, {
      title: 'Branch at Step 1',
      upToMessageIndex: 1
    });

    assert.ok(forked);
    assert.equal(forked.title, 'Branch at Step 1');
    assert.equal(forked.messages.length, 2);
    assert.equal(forked.messages[1].content, 'ack 1');

    deleteSession(parent.id);
    deleteSession(forked.id);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('security: permissions and standing approvals do NOT carry over across session forks (Claude Code Architecture p. 24)', () => {
  revokeAllAlways();

  // 1. Grant standing approval in process / parent session
  grantAlways('fs_write');
  grantAlways('sysRun');
  assert.equal(isAlwaysAllowed('fs_write'), true);
  assert.equal(isAlwaysAllowed('sysRun'), true);
  assert.equal(listAlwaysAllowed().length, 2);

  const ws = tempWorkspace();
  try {
    const parent = createSession(ws, 'Sensitive Deployment Session', true);
    saveSessionMessages(parent.id, [
      { role: 'user', content: 'Deploy to cluster' }
    ]);

    const forked = forkSession(parent.id);
    assert.ok(forked);

    // Create an AgentLoop for the forked session and reset its permissions scope
    const loop = new AgentLoop(null, 'forked_task_1', 'Deploy to alternative cluster', {
      workspaceRoot: ws,
      memorySessionId: forked.id
    });

    loop.resetApprovalScope();
    revokeAllAlways();

    // Verify all standing approvals are revoked in the forked session
    assert.equal(loop.isAlwaysAllowed('fs_write'), false, 'fs_write must not be auto-approved in fork');
    assert.equal(loop.isAlwaysAllowed('sysRun'), false, 'sysRun must not be auto-approved in fork');
    assert.equal(isAlwaysAllowed('fs_write'), false);
    assert.equal(isAlwaysAllowed('sysRun'), false);
    assert.equal(listAlwaysAllowed().length, 0);

    deleteSession(parent.id);
    deleteSession(forked.id);
  } finally {
    revokeAllAlways();
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('command: /fork command clones conversation and resets standing permissions', async () => {
  revokeAllAlways();
  grantAlways('fs_write');

  const ws = tempWorkspace();
  try {
    const memory = new MemoryManager(ws);
    const parent = memory.startNewSession('Root Session');
    saveSessionMessages(parent.id, [
      { role: 'user', content: 'Investigate performance bug' },
      { role: 'assistant', content: 'Found flamegraph bottleneck' }
    ]);
    memory.session = getSession(parent.id);

    const loop = new AgentLoop(null, 'task_main', null, {
      workspaceRoot: ws,
      memorySessionId: parent.id
    });
    loop.memoryManager = memory;

    let renderedHistory: any[] | null = null;
    let renderedMeta: any = null;
    const prompt = {
      renderer: {
        renderSessionHistory: (history: any[], meta: any) => {
          renderedHistory = history;
          renderedMeta = meta;
        }
      },
      surface: { viewport: { toBottom: () => {} } },
      editor: { clear: () => {} },
      scheduleDraw: () => {}
    };

    const parentId = parent.id;
    const result = await handleInput('/fork', { loop, prompt });
    assert.ok(result && result.ok, 'Fork command should succeed');
    assert.ok(result.output.includes('Forked session'));
    assert.ok(result.output.includes('Permissions and allowlists reset'));

    // Check new session
    const forkedId = memory.sessionId;
    assert.notEqual(forkedId, parentId, 'MemoryManager should now point to new forked session');
    assert.equal(renderedHistory?.length, 2);
    assert.equal(renderedMeta?.id, forkedId);

    // Crucial check: permissions reset!
    assert.equal(isAlwaysAllowed('fs_write'), false, 'Standing approval must be revoked');
    assert.equal(loop.isAlwaysAllowed('fs_write'), false);

    deleteSession(parent.id);
    if (forkedId) deleteSession(forkedId);
  } finally {
    revokeAllAlways();
    fs.rmSync(ws, { recursive: true, force: true });
  }
});
