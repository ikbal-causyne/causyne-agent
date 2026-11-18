import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { CausyneBrowser } from '../src/browser/causyneBrowser.js';

const executablePath = [
  process.env.CAUSYNE_BROWSER_EXECUTABLE,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
].filter(Boolean).find(existsSync);
if (!executablePath) throw new Error('Chromium/Chrome executable is required for authenticated isolation smoke');

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'causyne-browser-auth-'));
const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const account = url.searchParams.get('account');
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  if (url.pathname === '/login' && (account === 'A' || account === 'B')) {
    response.setHeader('set-cookie', `causyne_test_user=${account}; Path=/; HttpOnly; SameSite=Lax`);
    response.end(`<html><body><h1>Signed in as ${account}</h1></body></html>`);
    return;
  }
  if (url.pathname === '/whoami') {
    const cookie = request.headers.cookie ?? '';
    const observed = /(?:^|;\\s*)causyne_test_user=(A|B)(?:;|$)/.exec(cookie)?.[1] ?? 'Anonymous';
    response.end(`<html><body><h1>Identity: ${observed}</h1></body></html>`);
    return;
  }
  response.statusCode = 404;
  response.end('<html><body>Not found</body></html>');
});

function makeBrowser(workspace, profileDirectory) {
  return new CausyneBrowser({
    workspace,
    profileDirectory,
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

const a = makeBrowser(path.join(root, 'workspace-a'), path.join(root, 'profile-a'));
const b = makeBrowser(path.join(root, 'workspace-b'), path.join(root, 'profile-b'));

async function visit(browser, url, expected) {
  const result = await browser.run([
    { type: 'goto', url },
    { type: 'snapshot' }
  ]);
  assert.match(result[1].output, expected);
}

try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  await visit(a, `${base}/login?account=A`, /Signed in as A/);
  await visit(b, `${base}/whoami`, /Identity: Anonymous/);
  await visit(a, `${base}/whoami`, /Identity: A/);
  await visit(b, `${base}/login?account=B`, /Signed in as B/);
  await visit(a, `${base}/whoami`, /Identity: A/);
  await visit(b, `${base}/whoami`, /Identity: B/);

  // Closing and recreating one context must retain only its own authenticated state.
  await a.close();
  await visit(a, `${base}/whoami`, /Identity: A/);
  await visit(b, `${base}/whoami`, /Identity: B/);
  console.log('REAL_BROWSER_AUTH_ISOLATION_PASS: cookie separation, distinct profiles, restart persistence');
} finally {
  await Promise.allSettled([a.close(), b.close()]);
  if (server.listening) await new Promise(resolve => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
}
