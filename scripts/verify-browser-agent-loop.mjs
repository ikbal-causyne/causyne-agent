import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { AgentLoop } from '../src/agentLoop.js';
import { resolveTool } from '../src/tools/registry.js';
import { CausyneBrowser, BrowserBatchError } from '../src/browser/causyneBrowser.js';

const executablePath = [
  process.env.CAUSYNE_BROWSER_EXECUTABLE,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
].filter(Boolean).find(existsSync);
if (!executablePath) throw new Error('Chromium/Chrome executable is required for agent-loop integration');

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'causyne-browser-agentloop-'));
const beforeCwd = process.cwd();
const events = [];
const tool = resolveTool('browser_act');
assert.ok(tool, 'browser_act must be registered in the agent tool catalogue');
const originalExecute = tool.execute;
const server = http.createServer((_request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(`<!doctype html><html><body><h1>Verified app</h1>
    <button id="counter">Count: 0</button>
    <script>document.querySelector('#counter').onclick = () => {
      document.querySelector('#counter').textContent = 'Count: 1';
    };</script></body></html>`);
});
const browser = new CausyneBrowser({
  workspace: root,
  profileDirectory: path.join(root, '.profile'),
  ensureBrowserCapability: async () => ({ ok: true }),
  resolveRuntime: () => ({
    source: 'environment',
    installDirectory: path.dirname(executablePath),
    resourceDirectory: path.dirname(executablePath),
    executablePath
  }),
  loadBrowserEngine: async () => ({
    Camoufox: async options => chromium.launchPersistentContext(options.user_data_dir, {
      executablePath,
      headless: true,
      chromiumSandbox: false,
      serviceWorkers: 'block',
      args: ['--no-sandbox']
    })
  })
});
let executed = 0;

try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}/`;
  process.chdir(root);
  tool.execute = async args => {
    executed++;
    try {
      const results = await browser.run(args.actions, { workspace: root });
      return { success: true, data: results, output: JSON.stringify(results) };
    } catch (error) {
      if (error instanceof BrowserBatchError) {
        return {
          success: false,
          error: error.message,
          code: 'BROWSER_BATCH_PARTIAL_FAILURE',
          completedActions: error.completedActions,
          failedActionIndex: error.failedActionIndex,
          failedActionType: error.failedActionType
        };
      }
      return { success: false, error: String(error) };
    }
  };
  const loop = new AgentLoop(
    { readyState: 1, send(payload) { events.push(JSON.parse(payload)); } },
    'chromium-provider-host-integration',
    'Use the browser to inspect the local test application.',
    { workspaceRoot: root, autoApprove: true }
  );
  let turns = 0;
  loop.initializeProvider = () => ({
    supportsVision: false,
    supportsToolSearch: () => false,
    chat: async () => {
      turns++;
      if (turns === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'real-browser-tool',
            type: 'function',
            function: {
              name: 'browser_act',
              arguments: JSON.stringify({
                actions: [
                  { type: 'goto', url },
                  { type: 'snapshot' },
                  { type: 'click', selector: '#counter' },
                  { type: 'snapshot' }
                ]
              })
            }
          }],
          usage: { promptTokens: 5, completionTokens: 5 }
        };
      }
      loop.abort();
      return { content: '', usage: { promptTokens: 1, completionTokens: 1 } };
    }
  });
  await loop.run();
  assert.equal(executed, 1, 'agent host should dispatch exactly one browser tool call');
  const observation = loop.messages.find(message => message.role === 'tool' && message.name === 'browser_act');
  assert.ok(observation, 'agent must return tool evidence to its provider');
  const payload = JSON.parse(String(observation.content));
  assert.equal(payload.success, true, JSON.stringify(payload));
  assert.match(payload.data?.[1]?.output ?? '', /Verified app/);
  assert.match(payload.data?.[3]?.output ?? '', /Count: 1/);
  assert.equal(loop.webVerificationState.browserActUsed, true, 'DOM evidence must mark browser inspection');
  assert.equal(events.some(event => event.type === 'step_complete' && event.tool === 'browser_act'), true);
  console.log('REAL_BROWSER_AGENT_LOOP_PASS: simulated provider tool call, real Chromium click, observed DOM evidence');
} finally {
  tool.execute = originalExecute;
  process.chdir(beforeCwd);
  await browser.close();
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
