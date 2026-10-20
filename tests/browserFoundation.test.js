import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  CausyneBrowser,
  annotateAriaSnapshot,
  parseAriaRefs
} from '../src/browser/causyneBrowser.js';
import { isPrivateAddress, assertPublicWebUrl } from '../src/browser/urlPolicy.js';
import { MAX_SNAPSHOT_CHARS, windowSnapshot } from '../src/browser/snapshotWindow.js';
import { parseBingRss, parseDuckDuckGoHtml, searchPublicWeb } from '../src/browser/searchProviders.js';
import { resolveCamoufoxRuntime } from '../src/browser/camofoxRuntime.js';
import { htmlToReadableText } from '../src/tools/webFetch.js';
import { TOOLS_BY_GROUP } from '../src/provisioning/capabilityTools.js';
import { Sandbox } from '../src/sandbox.js';

const workspaces = [];

class FakeLocator {
  constructor(page, selector) {
    this.page = page;
    this.selector = selector;
    this.position = 0;
  }
  first() { return this; }
  nth(index) { this.position = index; return this; }
  async click() { this.page.calls.push(['click', this.selector, this.position]); }
  async fill(value) { this.page.calls.push(['fill', this.selector, value, this.position]); }
  async press(key) { this.page.calls.push(['press', this.selector, key]); }
  async selectOption(value) { this.page.calls.push(['select', this.selector, value]); }
  async innerText() { return 'Readable page content'; }
  async ariaSnapshot() {
    return '- heading "Test page"\n- textbox "Search"\n- link "First result"\n- button "Continue"';
  }
}

class FakePage {
  constructor() {
    this.currentUrl = 'about:blank';
    this.closed = false;
    this.calls = [];
    this.keyboard = { press: async key => { this.calls.push(['keyboard', key]); } };
    this.mouse = { wheel: async (x, y) => { this.calls.push(['wheel', x, y]); } };
  }
  isClosed() { return this.closed; }
  url() { return this.currentUrl; }
  async title() { return 'Test page'; }
  async goto(url) { this.currentUrl = url; this.calls.push(['goto', url]); return { status: () => 200, headers: () => ({ 'content-type': 'text/html' }) }; }
  async waitForLoadState() {}
  async waitForTimeout() {}
  async waitForEvent() {
    return {
      suggestedFilename: () => 'report.txt',
      saveAs: async target => { fs.writeFileSync(target, 'downloaded'); },
      failure: async () => null
    };
  }
  locator(selector) { return new FakeLocator(this, selector); }
  getByRole(role, options = {}) { return new FakeLocator(this, `${role}:${options.name ?? ''}`); }
  async evaluate() {
    if (this.currentUrl.includes('google.com')) return [];
    if (this.currentUrl.includes('duckduckgo.com')) {
      return [{ title: 'Causyne result', url: 'https://example.com/result', snippet: 'Result snippet' }];
    }
    return [];
  }
  async route() {}
  setDefaultTimeout() {}
  async goBack() { this.calls.push(['back']); }
  async goForward() { this.calls.push(['forward']); }
  async reload() { this.calls.push(['reload']); }
  async screenshot() { return Buffer.from('png image'); }
  async close() { this.closed = true; }
}

class FakeSession {
  constructor() { this.openPages = []; this.closed = false; }
  async newPage() { const page = new FakePage(); this.openPages.push(page); return page; }
  pages() { return this.openPages; }
  async close() { this.closed = true; }
}

function fakeRuntime() {
  const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-browser-')));
  workspaces.push(workspace);
  const session = new FakeSession();
  const browser = new CausyneBrowser({
    workspace,
    profileDirectory: path.join(workspace, '.profile'),
    ensureBrowserCapability: async () => ({ ok: true }),
    resolveRuntime: () => ({
      installDirectory: '/fake/camoufox',
      resourceDirectory: '/fake/resources',
      source: 'environment'
    }),
    loadCamoufox: async () => ({ Camoufox: async () => session }),
    validateUrl: async value => new URL(value)
  });
  return { workspace, session, browser };
}

afterEach(async () => {
  for (const workspace of workspaces.splice(0)) fs.rmSync(workspace, { recursive: true, force: true });
});

describe('Causyne Browser snapshot and refs', () => {
  test('interactive accessibility nodes receive stable refs', () => {
    const source = '- heading "Page"\n- textbox "Search"\n- link "Docs"\n- link "Docs"';
    const refs = parseAriaRefs(source);
    assert.deepEqual([...refs.entries()], [
      ['e1', { role: 'textbox', name: 'Search', nth: 0 }],
      ['e2', { role: 'link', name: 'Docs', nth: 0 }],
      ['e3', { role: 'link', name: 'Docs', nth: 1 }]
    ]);
    assert.match(annotateAriaSnapshot(source, refs), /link "Docs" \[e3\]/);
  });

  test('large snapshots are paged and retain a navigation tail', () => {
    const source = `${'x'.repeat(MAX_SNAPSHOT_CHARS + 1000)}TAIL-MARKER`;
    const first = windowSnapshot(source);
    assert.equal(first.truncated, true);
    assert.ok(first.nextOffset > 0);
    assert.match(first.text, /TAIL-MARKER/);
    assert.ok(first.text.length <= MAX_SNAPSHOT_CHARS);
  });
});

describe('Causyne Browser lifecycle', () => {
  test('search falls back from an empty Google page to DuckDuckGo', async () => {
    const { browser } = fakeRuntime();
    const results = await browser.search('causyne agent');
    assert.equal(results[0].engine, 'duckduckgo');
    assert.equal(results[0].title, 'Causyne result');
    await browser.close();
  });

  test('snapshot refs drive later interactions and extraction', async () => {
    const { browser } = fakeRuntime();
    const results = await browser.run([
      { type: 'goto', url: 'https://example.com/' },
      { type: 'snapshot' },
      { type: 'click', ref: 'e2' },
      { type: 'extract', selector: 'main' }
    ]);
    assert.match(results[1].output, /\[e2\]/);
    assert.equal(results[2].output, 'Element clicked');
    assert.equal(results[3].output, 'Readable page content');
    await browser.close();
  });

  test('downloads are written atomically inside the selected workspace', async () => {
    const { browser, workspace } = fakeRuntime();
    const results = await browser.run([
      { type: 'snapshot' },
      { type: 'download', ref: 'e2', outputFile: 'downloads/report.txt' }
    ]);
    assert.equal(fs.readFileSync(path.join(workspace, 'downloads', 'report.txt'), 'utf8'), 'downloaded');
    assert.match(results[1].output, /Downloaded 10 bytes/);
    await browser.close();
  });

  test('screenshots are bounded and written inside the selected workspace', async () => {
    const { browser, workspace } = fakeRuntime();
    const results = await browser.run([
      { type: 'screenshot', outputFile: 'screenshots/page.png', fullPage: true }
    ]);
    assert.equal(fs.readFileSync(path.join(workspace, 'screenshots', 'page.png'), 'utf8'), 'png image');
    assert.match(results[0].output, /Saved 9-byte screenshot/);
    await browser.close();
  });

  test('a download cannot escape the workspace', async () => {
    const { browser } = fakeRuntime();
    await browser.run([{ type: 'snapshot' }]);
    await assert.rejects(
      browser.run([{ type: 'download', ref: 'e2', outputFile: '../escape.txt' }]),
      /inside the selected workspace/
    );
    await browser.close();
  });
});

describe('web boundaries', () => {
  test('private and credential-bearing URLs are refused', async () => {
    for (const address of ['127.0.0.1', '10.0.0.1', '192.168.1.1', '192.0.2.1', '198.51.100.4', '203.0.113.9', '::1', 'fc00::1', '2001:db8::1', 'ff02::1']) {
      assert.equal(isPrivateAddress(address), true, address);
    }
    await assert.rejects(assertPublicWebUrl('http://127.0.0.1/admin'), /not allowed/);
    const credentialUrl = new URL('https://example.com/');
    credentialUrl.username = 'test-user';
    credentialUrl.password = 'test-password';
    await assert.rejects(assertPublicWebUrl(credentialUrl.href), /credentials/);
  });

  test('HTML becomes bounded readable prose instead of a regex-dependent SERP', () => {
    const text = htmlToReadableText('<style>x</style><h1>Causyne &amp; Browser</h1><p>Readable&nbsp;text.</p>');
    assert.equal(text, 'Causyne & Browser\nReadable text.');
  });

  test('sandbox blocks browser SSRF and escalates browser downloads', () => {
    const workspace = process.cwd();
    const sandbox = new Sandbox({ workspaceRoot: workspace });
    assert.equal(sandbox.validate('browser_act', { actions: [{ type: 'goto', url: 'http://127.0.0.1:8080' }] }).risk, 'forbidden');
    assert.equal(sandbox.validate('browser_act', { actions: [{ type: 'goto', url: 'http://[::1]/' }] }).risk, 'forbidden');
    assert.equal(sandbox.validate('browser_act', { actions: [{ type: 'goto', url: 'file:///etc/passwd' }] }).risk, 'forbidden');
    assert.equal(sandbox.validate('browser_act', { actions: [{ type: 'download', outputFile: 'file.bin' }] }).risk, 'extreme');
    assert.equal(sandbox.validate('browser_act', { actions: [
      { type: 'download', outputFile: 'file.bin' },
      { type: 'goto', url: 'http://127.0.0.1/private' }
    ] }).risk, 'forbidden');
    assert.equal(sandbox.validate('browser_act', { actions: [{ type: 'click', ref: 'e1' }] }).risk, 'dangerous');
    assert.equal(sandbox.validate('browser_act', { actions: [{ type: 'snapshot' }] }).risk, 'safe');
  });
});

describe('lightweight web search', () => {
  test('parses Bing RSS without a browser runtime', () => {
    const results = parseBingRss(`<?xml version="1.0"?><rss><channel><item>
      <title>Causyne documentation</title>
      <link>https://example.com/docs</link>
      <description>Technical documentation for Causyne.</description>
    </item></channel></rss>`);
    assert.deepEqual(results, [{
      title: 'Causyne documentation',
      url: 'https://example.com/docs',
      snippet: 'Technical documentation for Causyne.',
      engine: 'bing-rss'
    }]);
  });

  test('falls back to Bing RSS when DuckDuckGo has no results', async () => {
    const responses = [
      new Response('<html><body>No results</body></html>', { status: 200 }),
      new Response(`<rss><channel><item><title>Causyne guide</title><link>https://example.com/guide</link><description>A practical guide.</description></item></channel></rss>`, { status: 200 })
    ];
    const results = await searchPublicWeb('causyne guide', {
      fetchImpl: async () => responses.shift()
    });
    assert.equal(results[0].engine, 'bing-rss');
    assert.equal(results[0].url, 'https://example.com/guide');
    assert.equal(results[0].snippet, 'A practical guide.');
  });

  test('external Camoufox resolver never downloads a missing runtime', () => {
    const previous = process.env.CAUSYNE_CAMOFOX_EXECUTABLE;
    process.env.CAUSYNE_CAMOFOX_EXECUTABLE = path.join(os.tmpdir(), 'definitely-missing-camoufox');
    try {
      assert.throws(resolveCamoufoxRuntime, /does not download browser binaries automatically/);
    } finally {
      if (previous === undefined) delete process.env.CAUSYNE_CAMOFOX_EXECUTABLE;
      else process.env.CAUSYNE_CAMOFOX_EXECUTABLE = previous;
    }
  });

  test('browser provisioning contains no binary downloader and web search is not browser-gated', () => {
    const provisioner = fs.readFileSync(new URL('../src/provisioning/capabilityProvisioner.js', import.meta.url), 'utf8');
    assert.doesNotMatch(provisioner, /downloadBrowserArchive|provisionBrowserRuntime|daijro\/camoufox\/releases/);
    assert.equal(TOOLS_BY_GROUP.browser.includes('web_search'), false);
  });

  test('DuckDuckGo parser rejects the provider redirect and keeps the public result', () => {
    const results = parseDuckDuckGoHtml(`<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fpaper">Paper &amp; notes</a>`);
    assert.equal(results[0].title, 'Paper & notes');
    assert.equal(results[0].url, 'https://example.org/paper');
  });
});
