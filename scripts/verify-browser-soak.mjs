import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { CausyneBrowser } from '../src/browser/causyneBrowser.js';

function boundedEnv(name, fallback, max) {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }
  return value;
}

const iterations = boundedEnv('CAUSYNE_BROWSER_SOAK_ITERATIONS', 12, 10_000);
const workspaceCount = boundedEnv('CAUSYNE_BROWSER_SOAK_WORKSPACES', 3, 8);
const rssLimitMiB = boundedEnv('CAUSYNE_BROWSER_SOAK_RSS_LIMIT_MIB', 512, 8_192);
const executablePath = [
  process.env.CAUSYNE_BROWSER_EXECUTABLE,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
].filter(Boolean).find(existsSync);
if (!executablePath) throw new Error('No Chromium/Chrome executable available for soak test');

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'causyne-browser-soak-'));
let privateHits = 0;
let requestCount = 0;
const server = http.createServer((request, response) => {
  requestCount++;
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  response.setHeader('cache-control', 'no-store');
  response.setHeader('content-type', 'text/html; charset=utf-8');
  if (url.pathname === '/login') {
    const account = url.searchParams.get('account');
    if (!/^W[0-7]$/.test(account ?? '')) {
      response.writeHead(400).end('Invalid account');
      return;
    }
    response.setHeader('set-cookie', `soak_account=${account}; Path=/; HttpOnly; SameSite=Lax`);
    response.end(`<html><body><h1>Signed in: ${account}</h1></body></html>`);
    return;
  }
  if (url.pathname === '/private') {
    privateHits++;
    response.end('<html><body>Private local endpoint</body></html>');
    return;
  }
  const identity = /(?:^|; *)soak_account=(W[0-7])(?:;|$)/.exec(request.headers.cookie ?? '')?.[1] ?? 'Anonymous';
  const step = Number(url.searchParams.get('step') ?? -1);
  response.end(`<!doctype html><html><body><h1>Identity: ${identity}</h1>
    <p>Step: ${Number.isSafeInteger(step) ? step : -1}</p>
    <button id="counter">Clicks: 0</button>
    <script>document.querySelector('#counter').onclick = () => {
      document.querySelector('#counter').textContent = 'Clicks: 1';
    };</script></body></html>`);
});

function makeBrowser(index) {
  const workspace = path.join(root, `workspace-${index}`);
  return new CausyneBrowser({
    workspace,
    profileDirectory: path.join(root, `profile-${index}`),
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
}

const browsers = Array.from({ length: workspaceCount }, (_, index) => makeBrowser(index));
let peakRss = process.memoryUsage().rss;
const started = Date.now();
let completed = 0;
try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  await Promise.all(browsers.map(async (browser, index) => {
    const result = await browser.run([{ type: 'goto', url: `${base}/login?account=W${index}` }, { type: 'snapshot' }]);
    assert.match(result[1].output, new RegExp(`Signed in: W${index}`));
  }));

  for (let step = 0; step < iterations; step++) {
    await Promise.all(browsers.map(async (browser, index) => {
      const result = await browser.run([
        { type: 'goto', url: `${base}/work?step=${step}` },
        { type: 'snapshot' },
        { type: 'click', selector: '#counter' },
        { type: 'snapshot' }
      ]);
      assert.match(result[1].output, new RegExp(`Identity: W${index}`));
      assert.match(result[1].output, new RegExp(`Step: ${step}`));
      assert.match(result[3].output, /Clicks: 1/);
      const tabs = await browser.run([{ type: 'listTabs' }]);
      assert.equal(tabs[0].data.length, 1, 'browser must not leak tabs during repeated navigation');
      completed++;
    }));
    // Reuse one profile after a mid-run restart, while other contexts are still live.
    if (step === Math.floor(iterations / 2)) {
      await browsers[0].close();
    }
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    assert.ok(peakRss <= rssLimitMiB * 1024 * 1024, 'Node harness RSS exceeded configured limit');
  }

  // A page rendered from an untrusted preview origin must not reach a local
  // endpoint despite previous deliberate navigations to that same service.
  const workspace = path.join(root, 'workspace-0');
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(path.join(workspace, 'untrusted.html'), `<!doctype html><html><body>
    <h1>Untrusted preview</h1><script>
      fetch('${base}/private', { mode: 'no-cors' }).catch(() => {});
    </script></body></html>`);
  await browsers[0].run([{ type: 'preview', filePath: 'untrusted.html' }, { type: 'wait', timeout: 300 }]);
  assert.equal(privateHits, 0, 'untrusted browser origin accessed the local service');

  const duration = Date.now() - started;
  console.log(`REAL_BROWSER_SOAK_PASS workspaces=${workspaceCount} iterations=${iterations} completed=${completed} requests=${requestCount} elapsed_ms=${duration} node_peak_rss_mib=${Math.ceil(peakRss / 1048576)}`);
} finally {
  await Promise.allSettled(browsers.map(browser => browser.close()));
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
