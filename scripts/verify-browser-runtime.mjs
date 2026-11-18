import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { CausyneBrowser } from '../src/browser/causyneBrowser.js';

const candidates = [
  process.env.CAUSYNE_BROWSER_EXECUTABLE,
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
].filter(Boolean);
const executablePath = candidates.find(existsSync);
if (!executablePath) throw new Error('No installed Chromium/Chrome executable for runtime smoke test');

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'causyne-real-browser-'));
const pageHtml = `<!doctype html><html><head><title>Causyne Runtime</title></head>
<body><h1>Native browser integration</h1>
<button id="counter">Count: 0</button>
<script type="module">
const button = document.querySelector('#counter');
let count = 0;
button.addEventListener('click', () => { button.textContent = 'Count: ' + ++count; });
</script>
</body></html>`;
await fs.writeFile(path.join(root, 'index.html'), pageHtml);
const browser = new CausyneBrowser({
  workspace: root,
  profileDirectory: path.join(root, '.profile'),
  ensureBrowserCapability: async () => ({ ok: true }),
  resolveRuntime: () => ({
    installDirectory: path.dirname(executablePath), resourceDirectory: path.dirname(executablePath),
    executablePath, source: 'environment'
  }),
  loadBrowserEngine: async () => ({
    Camoufox: async () => chromium.launchPersistentContext(path.join(root, '.profile'), {
      executablePath,
      headless: true,
      chromiumSandbox: false,
      serviceWorkers: 'block',
      args: ['--no-sandbox']
    })
  })
});

try {
  const initial = await browser.run([
    { type: 'preview', filePath: 'index.html' },
    { type: 'snapshot' }
  ]);
  assert.equal(initial[0].action, 'preview');
  assert.match(initial[1].output, /Count: 0/);

  const changed = await browser.run([
    { type: 'click', selector: '#counter' },
    { type: 'snapshot' },
    { type: 'screenshot', outputFile: 'evidence.png' }
  ]);
  assert.match(changed[1].output, /Count: 1/);
  const png = await fs.readFile(path.join(root, 'evidence.png'));
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.ok(png.length > 100);
  console.log('REAL_BROWSER_SMOKE_PASS: isolated preview, DOM, click, snapshot, screenshot');
} finally {
  await browser.close();
  await fs.rm(root, { recursive: true, force: true });
}
