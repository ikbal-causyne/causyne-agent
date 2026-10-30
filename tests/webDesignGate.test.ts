import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentLoop } from '../src/agentLoop.js';

const genericPage = `<!doctype html><html><head><style>
body { font-family: system-ui, sans-serif; }
.hero { background: linear-gradient(135deg, #667eea, #764ba2); text-align: center; }
</style></head><body><section class="hero"><h1>Elevate Your Workflow</h1>
<a>Get Started</a><a>Learn More</a></section>
<div class="feature">🚀 Fast</div><div class="feature">✨ Easy</div><div class="feature">💡 Smart</div>
</body></html>`;

const consideredPage = `<!doctype html><html><head><style>
body { font-family: Georgia, serif; background: #f2ede3; color: #182820; }
header { border-bottom: 2px solid #182820; padding: 2rem; }
</style></head><body><header><h1>Field Notes</h1>
<p>A record of the community garden's planting seasons.</p></header></body></html>`;

test('web design audit requires a revision, then blocks completion without rendered inspection', async () => {
  const previousHome = process.env.CAUSYNE_HOME;
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-isolated-home-'));
  process.env.CAUSYNE_HOME = tempHome;
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-design-revise-'));
  fs.writeFileSync(path.join(workspace, 'package.json'), '{}');
  const page = path.join(workspace, 'index.html');
  const events: Array<{ type: string; content?: string; message?: string }> = [];

  try {
    const loop = new AgentLoop(
      { readyState: 1, send: payload => events.push(JSON.parse(payload)) },
      'design-revision',
      'build a website for a community garden',
      { workspaceRoot: workspace }
    );
    let calls = 0;
    let sawCapabilityFollowup = false;
    const model = {
      supportsVision: false,
      supportsToolSearch: () => false,
      chat: async (messages: Array<{ content: unknown }>) => {
        calls++;
        sawCapabilityFollowup ||= messages.some(message => typeof message.content === 'string'
          && message.content.includes('grant_capability') && message.content.includes('browser'));
        fs.writeFileSync(page, calls === 1 ? genericPage : consideredPage);
        return {
          content: calls === 1 ? 'The website is complete.' : 'Revised the website and checked its files.',
          externalActions: [{ name: 'write_file', status: 'completed', detail: 'index.html' }],
          usage: { promptTokens: 20, completionTokens: 12 }
        };
      }
    };
    loop.initializeProvider = () => model as never;
    loop.llm = model as never;

    await loop.run();

    assert.equal(calls, 3, 'a missing browser gets an execution opportunity after the design revision');
    assert.equal(sawCapabilityFollowup, true);
    assert.equal(events.some(event => event.type === 'agent_message' && event.content === 'The website is complete.'), false);
    assert.equal(events.some(event => event.type === 'task_complete'), false);
    assert.equal(events.some(event => event.type === 'error' && event.message?.includes('rendered-page verification did not succeed')), true);
    assert.equal(fs.readFileSync(page, 'utf8'), consideredPage);
  } finally {
    if (previousHome !== undefined) process.env.CAUSYNE_HOME = previousHome;
    else delete process.env.CAUSYNE_HOME;
    fs.rmSync(tempHome, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('unchanged generic output stops without a false completion', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-design-stuck-'));
  fs.writeFileSync(path.join(workspace, 'package.json'), '{}');
  fs.writeFileSync(path.join(workspace, 'index.html'), genericPage);
  const events: Array<{ type: string; message?: string }> = [];

  try {
    const loop = new AgentLoop(
      { readyState: 1, send: payload => events.push(JSON.parse(payload)) },
      'design-stuck',
      'build a website for a community garden',
      { workspaceRoot: workspace }
    );
    let calls = 0;
    const model = {
      supportsVision: false,
      supportsToolSearch: () => false,
      chat: async () => {
        calls++;
        return {
          content: 'The website is complete.',
          externalActions: [{ name: 'write_file', status: 'completed', detail: 'index.html' }],
          usage: { promptTokens: 20, completionTokens: 12 }
        };
      }
    };
    loop.initializeProvider = () => model as never;
    loop.llm = model as never;

    await loop.run();

    assert.equal(calls, 2);
    assert.equal(events.some(event => event.type === 'task_complete'), false);
    assert.equal(events.some(event => event.type === 'error' && event.message?.includes('not verified as complete')), true);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('missing provider-written page cannot pass the design audit', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-design-missing-'));
  fs.writeFileSync(path.join(workspace, 'package.json'), '{}');
  const events: Array<{ type: string; message?: string }> = [];

  try {
    const loop = new AgentLoop(
      { readyState: 1, send: payload => events.push(JSON.parse(payload)) },
      'design-missing',
      'build a website for a community garden',
      { workspaceRoot: workspace }
    );
    const model = {
      supportsVision: false,
      supportsToolSearch: () => false,
      chat: async () => ({
        content: 'The website is complete.',
        externalActions: [{ name: 'write_file', status: 'completed', detail: 'index.html' }],
        usage: { promptTokens: 20, completionTokens: 12 }
      })
    };
    loop.initializeProvider = () => model as never;
    loop.llm = model as never;

    await loop.run();

    assert.equal(events.some(event => event.type === 'task_complete'), false);
    assert.equal(events.some(event => event.type === 'error' && event.message?.includes('could not read')), true);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
