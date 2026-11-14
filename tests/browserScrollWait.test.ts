import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CausyneBrowser } from '../src/browser/causyneBrowser.js';

const workspaces: string[] = [];

afterEach(() => {
  for (const workspace of workspaces.splice(0)) {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('scroll and wait fall back to finite defaults when numeric parameters are NaN or non-finite', async () => {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-browser-scroll-')));
  workspaces.push(workspace);

  const calls: Array<unknown[]> = [];
  const fakePage = {
    currentUrl: 'about:blank',
    closed: false,
    isClosed() { return this.closed; },
    url() { return this.currentUrl; },
    async title() { return 'Scroll Wait Test'; },
    async goto(url: string) { this.currentUrl = url; return { status: () => 200, headers: () => ({ 'content-type': 'text/html' }) }; },
    async waitForLoadState() {},
    async waitForTimeout(ms: number) { calls.push(['waitForTimeout', ms]); },
    async waitForSelector(_selector: string, options?: { timeout?: number }) {
      calls.push(['waitForSelector', options?.timeout]);
    },
    locator() { return { first: () => this }; },
    async evaluate() { return true; },
    async route() {},
    setDefaultTimeout() {},
    keyboard: { press: async () => {} },
    mouse: { wheel: async (x: number, y: number) => { calls.push(['wheel', x, y]); } },
    async close() { this.closed = true; }
  };

  const session = {
    pages: () => [fakePage],
    newPage: async () => fakePage,
    close: async () => {}
  };

  const browser = new CausyneBrowser({
    workspace,
    profileDirectory: path.join(workspace, '.profile'),
    ensureBrowserCapability: async () => ({ ok: true }),
    resolveRuntime: () => ({
      installDirectory: '/fake/causyne-browser',
      resourceDirectory: '/fake/resources',
      source: 'environment'
    }),
    loadBrowserEngine: async () => ({ Camoufox: async () => session }),
    validateUrl: async (value: string) => new URL(value)
  });

  try {
    const results = await browser.run([
      { type: 'scroll', direction: 'down', amount: Number.NaN },
      { type: 'wait', timeout: Number.NaN },
      { type: 'wait', selector: '#ready', timeout: Number.POSITIVE_INFINITY }
    ]);

    assert.equal(results[0]?.output, 'Scrolled down 700px');
    assert.deepEqual(calls.find(entry => entry[0] === 'wheel'), ['wheel', 0, 700]);
    assert.deepEqual(calls.find(entry => entry[0] === 'waitForTimeout'), ['waitForTimeout', 1000]);
    assert.deepEqual(calls.find(entry => entry[0] === 'waitForSelector'), ['waitForSelector', 1000]);
  } finally {
    await browser.close();
  }
});
