import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentLoop } from '../src/agentLoop.js';
import { isPlanningOnlyRequest, isPlanReviewHandoff } from '../src/taskContinuation.js';
import { requiresImplementationPlan } from '../src/decisionPolicy.js';

test('plan-review handoffs are distinct from explicit planning-only requests', () => {
  assert.equal(isPlanReviewHandoff('The plan is ready. Click Proceed to start implementation.'), true);
  assert.equal(isPlanReviewHandoff('Silakan tinjau rencananya dan klik **Proceed** agar eksekusi dapat dimulai.'), true);
  assert.equal(isPlanReviewHandoff('Implemented the plan and verified the output.'), false);
  assert.equal(isPlanningOnlyRequest('Only plan the migration; wait for my review.'), true);
  assert.equal(isPlanningOnlyRequest('Research and plan first, then implement the feature.'), false);
  assert.equal(isPlanningOnlyRequest('Create the requested application.'), false);
});

test('simple file I/O does not acquire a complex-app checklist, while actual projects retain it', () => {
  assert.equal(requiresImplementationPlan('Create proof.txt containing READY, then read proof.txt to verify it.', 'build_app', 'high'), false);
  assert.equal(requiresImplementationPlan('Research 100 keyboards and create keyboards.json for the application.', 'build_app', 'high'), true);
  assert.equal(requiresImplementationPlan('Create package.json for the new workspace', 'build_app', 'high'), true);
  assert.equal(requiresImplementationPlan('Integrate a plugin system', 'integrate', 'medium'), true);
});

test('readback cannot prefetch stale contents across an earlier file mutation', () => {
  const loop = Object.create(AgentLoop.prototype) as AgentLoop;
  loop.config = { autonomyMode: 'C' };
  const calls = ['fs_write', 'fs_read', 'fs_read'].map((name, index) => ({ id: String(index),
    function: { name, arguments: JSON.stringify({ path: 'proof.txt', content: 'READY' }) } }));
  assert.equal(loop.prefetchReadOnlyCalls(calls).size, 0);
});

test('web design instructions reach the first real request after userPrompt is consumed', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-web-playbook-'));
  let sawWebPlaybook = false;
  const prompt = 'Find at least 100 keyboards then build a landing page called Open Keyboard';
  const loop = new AgentLoop({ readyState: 1, send: () => {} }, 'keyboard-playbook', prompt, { workspaceRoot: workspace });
  loop.initializeProvider = () => ({ supportsVision: false, supportsToolSearch: () => false,
    chat: async (messages: Array<{ role: string; content: unknown }>) => {
      assert.equal(loop.userPrompt, null);
      sawWebPlaybook = messages.some(message => typeof message.content === 'string'
        && message.content.includes('FRONTEND ENGINEERING MANDATE'));
      throw new Error('401 fixture: stop after observing the assembled request');
    } }) as never;
  try { await loop.run(); assert.equal(sawWebPlaybook, true); }
  finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

test('verification from a previous task cannot certify the next task', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-verification-reset-'));
  const loop = new AgentLoop({ readyState: 1, send: () => {} }, 'verification-reset', 'Build a new website', { workspaceRoot: workspace });
  loop.webVerificationState = { screenshotTaken: true, browserActUsed: true, htmlInspected: true };
  let checked = false;
  loop.initializeProvider = () => ({ supportsVision: false, supportsToolSearch: () => false,
    chat: async () => {
      assert.deepEqual(loop.webVerificationState, { screenshotTaken: false, browserActUsed: false, htmlInspected: false });
      checked = true;
      throw new Error('401 fixture: stop after inspecting the task state');
    } }) as never;
  try { await loop.run(); assert.equal(checked, true); }
  finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

test('a native plan artifact cannot end an implementation request before Causyne writes the deliverable', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-plan-continuation-'));
  const events: Array<{ type: string; message?: string }> = [];
  let calls = 0;
  const loop = new AgentLoop({ readyState: 1, send: value => events.push(JSON.parse(value)) },
    'plan-continuation', 'Create proof.txt containing READY', { workspaceRoot: workspace });
  loop.initializeProvider = () => {
    loop.config.autonomyMode = 'C';
    return { supportsVision: false, supportsToolSearch: () => false,
      chat: async () => {
        calls++;
        if (calls === 1) return { content: 'The plan is ready. Click Proceed to start implementation.',
          externalActions: [{ name: 'write_file', status: 'completed', detail: '/peer/brain/implementation_plan.md' }],
          usage: { promptTokens: 10, completionTokens: 5 } };
        if (calls === 2) return { content: '',
          toolCalls: [{ id: 'write-proof', type: 'function', function: { name: 'fs_write',
            arguments: JSON.stringify({ path: path.join(workspace, 'proof.txt'), content: 'READY' }) } }],
          usage: { promptTokens: 10, completionTokens: 5 } };
        return { content: 'Created proof.txt.', usage: { promptTokens: 10, completionTokens: 5 } };
      } } as never;
  };
  try {
    await loop.run();
    assert.equal(calls, 3);
    assert.ok(fs.existsSync(path.join(workspace, 'proof.txt')), JSON.stringify(events));
    assert.equal(fs.readFileSync(path.join(workspace, 'proof.txt'), 'utf8'), 'READY');
    assert.ok(events.some(event => event.type === 'status' && event.message?.includes('Continuing the requested implementation')));
    assert.equal(events.some(event => event.type === 'task_complete'), true);
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});

test('an inspected HTML deliverable completes verification when browser runtime is unavailable', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-browser-continuation-'));
  const events: Array<{ type: string; message?: string }> = [];
  const loop = new AgentLoop({ readyState: 1, send: value => events.push(JSON.parse(value)) }, 'browser-continuation',
    'Build a landing page', { workspaceRoot: workspace });
  let calls = 0;
  loop.initializeProvider = () => ({ supportsVision: false, supportsToolSearch: () => false,
    chat: async () => {
      calls++;
      fs.writeFileSync(path.join(workspace, 'index.html'), '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Landing Page</title><style>body { font-family: sans-serif; }</style></head><body><header><h1>Crafted Space</h1></header><main><p>Content details.</p></main></body></html>');
      return { content: 'Built and verified index.html.', externalActions: [
        { name: 'write_file', status: 'completed', detail: 'index.html' },
        { name: 'read_file', status: 'completed', detail: 'index.html' }
      ], usage: { promptTokens: 10, completionTokens: 5 } };
    } }) as never;
  try {
    await loop.run();
    assert.equal(calls, 1);
    assert.equal(events.some(event => event.type === 'task_complete'), true);
    assert.equal(events.some(event => event.type === 'error'), false);
  } finally { fs.rmSync(workspace, { recursive: true, force: true }); }
});
