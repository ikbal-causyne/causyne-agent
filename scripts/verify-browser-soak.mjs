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
const treePssLimitMiB = boundedEnv('CAUSYNE_BROWSER_SOAK_TREE_PSS_LIMIT_MIB', 3_072, 32_768);
const executablePath = [
  process.env.CAUSYNE_BROWSER_EXECUTABLE,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
].filter(Boolean).find(existsSync);
if (!executablePath) throw new Error('No Chromium/Chrome executable available for soak test');

async function processTreeRss() {
  if (process.platform !== 'linux') return null;
  const entries = new Map();
  for (const entry of await fs.readdir('/proc', { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    try {
      const status = await fs.readFile(`/proc/${pid}/status`, 'utf8');
      const parent = Number(/^PPid:\s*(\d+)/m.exec(status)?.[1] ?? -1);
      const rssKiB = Number(/^VmRSS:\s*(\d+)/m.exec(status)?.[1] ?? 0);
      entries.set(pid, { parent, rssKiB });
    } catch {
      // The process may have exited during sampling.
    }
  }
  const descendantPids = new Set([process.pid]);
  let changed;
  do {
    changed = false;
    for (const [pid, details] of entries) {
      if (!descendantPids.has(pid) && descendantPids.has(details.parent)) {
        descendantPids.add(pid);
        changed = true;
      }
    }
  } while (changed);
  let rssKiB = 0;
  let pssKiB = 0;
  let pssSampled = 0;
  for (const pid of descendantPids) {
    const processInfo = entries.get(pid);
    if (!processInfo) continue;
    rssKiB += processInfo.rssKiB;
    try {
      const rollup = await fs.readFile(`/proc/${pid}/smaps_rollup`, 'utf8');
      const pss = /^Pss:\s*(\d+)/m.exec(rollup);
      if (pss) {
        pssKiB += Number(pss[1]);
        pssSampled++;
      }
    } catch {
      // A child process can exit while process memory is sampled.
    }
  }
  return {
    rssMiB: Math.ceil(rssKiB / 1024),
    pssMiB: Math.ceil(pssKiB / 1024),
    pssSampled,
    processCount: descendantPids.size
  };
}

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
    response.setHeader('set-cookie', `soak_account=${account}; Path=/; Max-Age=3600; HttpOnly; SameSite=Lax`);
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
let peakTreeRssMiB = 0;
let peakTreePssMiB = 0;
let peakChildProcesses = 0;
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
      if (step % 4 === 0) {
        const newTab = await browser.run([{ type: 'newTab' }]);
        assert.ok(newTab[0].tabId);
        await browser.run([{ type: 'closeTab', tabId: newTab[0].tabId }]);
        const afterClose = await browser.run([{ type: 'listTabs' }]);
        assert.equal(afterClose[0].data.length, 1, 'temporary browser tabs must be reclaimed');
      }
      completed++;
    }));
    // Reuse one profile after a mid-run restart, while other contexts are still live.
    if (step === Math.floor(iterations / 2)) {
      await browsers[0].close();
    }
    peakRss = Math.max(peakRss, process.memoryUsage().rss);
    assert.ok(peakRss <= rssLimitMiB * 1024 * 1024, 'Node harness RSS exceeded configured limit');
    const tree = await processTreeRss();
    if (tree) {
      assert.ok(tree.rssMiB > 0 && tree.processCount > 1 && tree.pssSampled > 1,
        'Process-tree sampler did not observe Chromium children or usable PSS');
      peakTreeRssMiB = Math.max(peakTreeRssMiB, tree.rssMiB);
      peakTreePssMiB = Math.max(peakTreePssMiB, tree.pssMiB);
      peakChildProcesses = Math.max(peakChildProcesses, tree.processCount);
      assert.ok(tree.pssMiB <= treePssLimitMiB,
        `Browser process tree exceeded PSS ceiling: ${tree.pssMiB} MiB > ${treePssLimitMiB} MiB`);
    }
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
  console.log(`REAL_BROWSER_SOAK_PASS workspaces=${workspaceCount} iterations=${iterations} completed=${completed} requests=${requestCount} elapsed_ms=${duration} node_peak_rss_mib=${Math.ceil(peakRss / 1048576)} tree_peak_rss_mib=${peakTreeRssMiB} tree_peak_pss_mib=${peakTreePssMiB} peak_processes=${peakChildProcesses}`);
} finally {
  await Promise.allSettled(browsers.map(browser => browser.close()));
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
