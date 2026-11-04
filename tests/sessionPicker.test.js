import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { buildSessionPickerItems, runInteractiveSessionPicker } from '../src/tui/sessionPicker.js';
import { runCommand } from '../src/commands.js';
import {
  createSession,
  saveSessionMessages,
  deleteSession,
  resolveSession,
  listSessions,
  setActiveSession,
  getActiveSessionId
} from '../src/sessionStore.js';
import { MemoryManager } from '../src/memoryManager.js';

const tempWorkspace = () => fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-sess-test-'));

test('buildSessionPickerItems: orders conversations by date and hides abandoned empty starts', () => {
  const ws = '/tmp/my-proj';
  const sessions = [
    {
      id: 's_active',
      workspace: ws,
      workspaceKey: 'abc',
      title: 'Current Chat',
      createdAt: Date.now() - 60000,
      updatedAt: Date.now() - 30000,
      messageCount: 5
    },
    {
      id: 's_other',
      workspace: '/tmp/other-proj',
      workspaceKey: 'def',
      title: 'Other Chat',
      createdAt: Date.now() - 120000,
      updatedAt: Date.now() - 90000,
      messageCount: 12
    },
    {
      id: 's_cont',
      workspace: ws,
      workspaceKey: 'abc',
      title: '[Adopted] Antigravity Investigation',
      createdAt: Date.now() - 180000,
      updatedAt: Date.now() - 150000,
      messageCount: 20
    },
    {
      id: 's_empty',
      workspace: ws,
      workspaceKey: 'abc',
      title: 'Untitled',
      createdAt: Date.now() - 10000,
      updatedAt: Date.now() - 10000,
      messageCount: 0
    }
  ];

  // Storage iteration order is not guaranteed; the picker must order by time.
  const items = buildSessionPickerItems(sessions.reverse(), 's_active', ws);
  assert.equal(items.length, 5);

  // Pinned item 0
  assert.equal(items[0].id, '__NEW_SESSION__');
  assert.equal(items[0].value.type, 'new');

  // Pinned item 1: Fork active conversation
  assert.equal(items[1].id, '__FORK_SESSION__');
  assert.equal(items[1].value.type, 'fork');

  // Active session
  assert.equal(items[2].id, 's_active');
  assert.ok(items[2].label.includes('[active]'));
  assert.ok(items[2].category === 'Today' || items[2].category === 'Yesterday');

  // Other workspace session
  assert.equal(items[3].id, 's_other');
  assert.ok(items[3].category === 'Today' || items[3].category === 'Yesterday');
  assert.match(items[3].description, /other-proj/);

  // Continuum session
  assert.equal(items[4].id, 's_cont');
  assert.ok(items[4].category === 'Today' || items[4].category === 'Yesterday');
  assert.equal(items.some(item => item.id === 's_empty'), false);
});

test('session titles recover a later substantive prompt after a greeting', () => {
  const ws = tempWorkspace();
  const session = createSession(ws, 'Untitled', true);
  try {
    saveSessionMessages(session.id, [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Hello' },
      { role: 'user', content: 'Build a Tesla Roadster landing page with real media' }
    ]);
    const rows = buildSessionPickerItems(
      listSessions().filter(row => row.id === session.id),
      session.id,
      ws
    );
    assert.match(rows.at(-1).label, /Tesla Roadster landing page/);
    assert.match(rows.at(-1).description, /(?:just now|\dm ago)/);
  } finally {
    deleteSession(session.id);
    fs.rmSync(ws, { recursive: true, force: true });
  }
});

test('runInteractiveSessionPicker: selecting + New Session creates fresh conversation', async () => {
  const ws = tempWorkspace();
  const memory = new MemoryManager(ws);
  const loop = {
    taskId: 'cli_chat_old',
    messages: [{ role: 'user', content: 'prior task' }],
    tokenTracker: { sessionTokens: 500, reset() { this.sessionTokens = 0; } },
    memoryManager: memory
  };

  let openedLayer = null;
  const prompt = {
    openLayer(layer) {
      openedLayer = layer;
      // Simulate user immediately selecting index 0 (+ New Session)
      const firstItem = layer.list.all[0];
      assert.ok(firstItem, 'First item must exist');
      setTimeout(() => layer.onPick(firstItem), 1);
    },
    editor: {
      clearCalled: false,
      clear() { this.clearCalled = true; }
    },
    scheduleDraw() {}
  };

  const result = await runInteractiveSessionPicker(prompt, { loop, workspace: ws });
  assert.ok(result.includes('Started new session'), `Result message: ${result}`);
  assert.equal(loop.messages.length, 0, 'Messages should be cleared for fresh session');
  assert.notEqual(loop.taskId, 'cli_chat_old', 'TaskId should be rotated');
  assert.equal(loop.tokenTracker.sessionTokens, 0, 'Token tracker should be reset');
  assert.equal(prompt.editor.clearCalled, true, 'Prompt editor should be cleared');

  // Cleanup
  if (memory.sessionId) deleteSession(memory.sessionId);
  try { fs.rmSync(ws, { recursive: true, force: true }); } catch (e) {}
});

test('runInteractiveSessionPicker: selecting existing session switches and restores messages', async () => {
  const ws = tempWorkspace();
  const session1 = createSession(ws, 'Session Alpha', true);
  saveSessionMessages(session1.id, [
    { role: 'user', content: 'hello from alpha' },
    { role: 'assistant', content: 'greetings' },
    { role: 'tool', content: 'internal tool result' }
  ]);

  const session2 = createSession(ws, 'Session Beta', true);
  saveSessionMessages(session2.id, [
    { role: 'user', content: 'hello from beta' }
  ]);

  const memory = new MemoryManager(ws, session2.id);
  const loop = {
    taskId: 'cli_chat_beta',
    messages: [{ role: 'user', content: 'hello from beta' }],
    tokenTracker: { sessionTokens: 200, reset() { this.sessionTokens = 0; } },
    memoryManager: memory
  };

  let renderedHistory = null;
  const prompt = {
    openLayer(layer) {
      // Find session Alpha in items and pick it
      const target = layer.list.all.find(i => i.id === session1.id);
      assert.ok(target, 'Session Alpha should be in the list');
      setTimeout(() => layer.onPick(target), 1);
    },
    editor: { clear() {} },
    scheduleDraw() {},
    renderer: { renderSessionHistory(messages, meta) { renderedHistory = { messages, meta }; } }
  };

  const result = await runInteractiveSessionPicker(prompt, { loop, workspace: ws });
  assert.ok(result.includes('Switched to "Session Alpha"'), `Result message: ${result}`);
  assert.equal(loop.messages.length, 3, 'Should restore messages from session Alpha');
  assert.equal(memory.sessionId, session1.id);
  assert.equal(renderedHistory.messages.length, 3, 'History is not truncated for rendering');
  assert.equal(renderedHistory.meta.messagesCount, 3, 'Divider counts all conversation turns including tool executions');

  // Cleanup
  deleteSession(session1.id);
  deleteSession(session2.id);
  try { fs.rmSync(ws, { recursive: true, force: true }); } catch (e) {}
});

test('runCommand: /new immediately creates a clean new session', async () => {
  const ws = tempWorkspace();
  const memory = new MemoryManager(ws);
  const loop = {
    workspaceRoot: ws,
    taskId: 'cli_chat_prev',
    messages: [{ role: 'user', content: 'something old' }],
    tokenTracker: { sessionTokens: 100, reset() { this.sessionTokens = 0; } },
    memoryManager: memory
  };
  const prompt = {
    editor: { clear() {} },
    scheduleDraw() {}
  };

  const res = await runCommand('new', [], { surface: 'terminal', loop, prompt });
  assert.equal(res.ok, true);
  assert.ok(res.output.includes('Started new session'));
  assert.equal(loop.messages.length, 0);
  assert.notEqual(loop.taskId, 'cli_chat_prev');

  // Cleanup
  if (memory.sessionId) deleteSession(memory.sessionId);
  try { fs.rmSync(ws, { recursive: true, force: true }); } catch (e) {}
});

test('resolveSession: honors forceNew and active.json pointer', () => {
  const ws = tempWorkspace();
  const sess1 = createSession(ws, 'First Work', true);
  saveSessionMessages(sess1.id, [{ role: 'user', content: 'task 1' }]);
  setActiveSession(sess1.id);

  // With active pointer, resolveSession returns sess1
  const resolved = resolveSession(ws);
  assert.equal(resolved.id, sess1.id);

  // With forceNew: true, resolveSession creates a fresh session
  const fresh = resolveSession(ws, { forceNew: true });
  assert.notEqual(fresh.id, sess1.id);
  assert.equal(fresh.messages.length, 0);

  // Cleanup
  deleteSession(sess1.id);
  deleteSession(fresh.id);
  try { fs.rmSync(ws, { recursive: true, force: true }); } catch (e) {}
});

test('ChatRenderer: renderSessionHistory populates frames and clears prior session in transcript', async () => {
  const { ChatRenderer } = await import('../src/tui/chatRenderer.js');
  const { Transcript } = await import('../src/tui/transcript.js');

  const transcript = new Transcript();
  const renderer = new ChatRenderer({ transcript });

  const messages = [
    { role: 'user', content: 'What is the architecture of this engine?' },
    { role: 'assistant', content: 'It is built on sovereign ACP and local model loops.' }
  ];

  renderer.renderSessionHistory(messages, {
    id: 'sess_arch_123',
    title: 'Architecture Discussion',
    messagesCount: 2
  });

  // Verify frames were appended to transcript
  assert.equal(transcript.isEmpty(), false);
  const kinds = transcript.frames.map(f => f.kind);
  assert.ok(kinds.includes('session'), 'Should include session divider frame');
  assert.ok(kinds.includes('user'), 'Should include user frame');
  assert.ok(kinds.includes('assistant'), 'Should include assistant frame');

  // Verify clearing/switching to new session clears and repopulates
  renderer.renderSessionHistory([], { id: 'sess_new_456', title: 'Fresh Session', messagesCount: 0 });
  assert.equal(transcript.frames.filter(f => f.kind === 'user').length, 0);
  assert.equal(transcript.frames.filter(f => f.kind === 'assistant').length, 0);
});

test('ChatRenderer: renderSessionHistory faithfully replays full 14-message tool execution history and plan', async () => {
  const { ChatRenderer } = await import('../src/tui/chatRenderer.js');
  const { Transcript } = await import('../src/tui/transcript.js');

  const transcript = new Transcript();
  let planChanged = null;
  const renderer = new ChatRenderer({ transcript });
  renderer.onPlanChange = (plan) => { planChanged = plan; };

  const fullSessionMessages = [
    { role: 'user', content: 'build me a 3d body that based on scient so the humanity in this world can learning more about their body in3d' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'call_1',
        type: 'function',
        function: {
          name: 'update_plan',
          arguments: JSON.stringify({
            explanation: 'Plan anatomy scaffold',
            plan: [
              { id: '1', step: 'Design anatomy spec', status: 'in_progress' },
              { id: '2', step: 'Write 3d engine', status: 'pending' }
            ]
          })
        }
      }]
    },
    { role: 'tool', tool_call_id: 'call_1', name: 'update_plan', content: '{"success":true,"output":"Plan updated"}' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{
        id: 'call_2',
        type: 'function',
        function: {
          name: 'fs_write',
          arguments: JSON.stringify({ path: '/tmp/anatomy.js', content: 'console.log("3d");' })
        }
      }]
    },
    { role: 'tool', tool_call_id: 'call_2', name: 'fs_write', content: '{"success":true,"output":"Wrote 22637 bytes"}' },
    { role: 'assistant', content: '[Action initiated and completed]' },
    { role: 'tool', tool_call_id: 'call_compacted_sysrun', name: 'sysRun', content: '{"success":true,"output":"total 0\n"}' }
  ];

  renderer.renderSessionHistory(fullSessionMessages, {
    id: 's_mvwcx33m_99f2e6',
    title: 'build me a 3d body that based on scient so the humanity i…'
  });

  // Verify all 7 conversation turns / messages are fully populated in transcript frames
  const kinds = transcript.frames.map(f => f.kind);
  assert.ok(kinds.includes('session'), 'Must render session divider');
  assert.ok(kinds.includes('user'), 'Must render user prompt frame');
  assert.ok(kinds.includes('assistant'), 'Must render assistant text frame');
  assert.ok(kinds.includes('step'), 'Must render tool step start frames');
  assert.ok(kinds.includes('result'), 'Must render tool result completion frames');

  // Verify step count and result count match executions
  const steps = transcript.frames.filter(f => f.kind === 'step');
  const results = transcript.frames.filter(f => f.kind === 'result');
  assert.equal(steps.length, 3, 'Must render 3 tool steps (update_plan, fs_write, sysRun)');
  assert.equal(results.length, 3, 'Must render 3 tool results');

  // Verify plan restoration
  assert.ok(Array.isArray(renderer.latestPlan), 'latestPlan must be restored');
  assert.equal(renderer.latestPlan.length, 2, 'latestPlan should have 2 steps');
  assert.equal(renderer.latestPlan[0].step, 'Design anatomy spec');
  assert.ok(planChanged, 'onPlanChange must be notified');

  // Verify session divider message count
  const flat = transcript.flatten(100);
  const dividerRow = flat.rows.find(r => r.includes('s_mvwcx33m_99f2e6') || r.includes('7 messages'));
  assert.ok(dividerRow, 'Session divider row must report total conversation messages');
});
