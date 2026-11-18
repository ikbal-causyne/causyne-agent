import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { CausyneBrowser, causyneBrowser, closeCausyneBrowser } from '../src/browser/causyneBrowser.js';

test('workspace factory isolates sessions and persistent authentication profiles', async () => {
  const a = path.resolve(process.cwd(), 'workspace-a');
  const b = path.resolve(process.cwd(), 'workspace-b');
  const browserA = causyneBrowser({ workspace: a });
  const browserB = causyneBrowser({ workspace: b });
  try {
    assert.notStrictEqual(browserA, browserB);
    assert.strictEqual(causyneBrowser({ workspace: a }), browserA);
    assert.strictEqual(causyneBrowser({ workspace: b }), browserB);
    assert.equal(browserA.getWorkspace(), a);
    assert.equal(browserB.getWorkspace(), b);
    assert.notEqual((browserA as any).profileDirectory, (browserB as any).profileDirectory);
    assert.match((browserA as any).profileDirectory, /browser-profiles/);
    assert.match((browserB as any).profileDirectory, /browser-profiles/);
  } finally {
    await closeCausyneBrowser();
  }
  assert.notStrictEqual(causyneBrowser({ workspace: a }), browserA);
  await closeCausyneBrowser();
});

test('a started browser rejects workspace migration and foreign action workspace overrides', async () => {
  const workspace = path.resolve(process.cwd(), 'workspace-primary');
  const otherWorkspace = path.resolve(process.cwd(), 'workspace-foreign');
  const page = {
    isClosed: () => false,
    url: () => 'about:blank',
    title: async () => 'Empty',
    setDefaultTimeout() {},
    route: async () => {},
    on() {},
    close: async () => {}
  };
  let launched = 0;
  const session = {
    pages: () => [page],
    newPage: async () => page,
    close: async () => {}
  };
  const browser = new CausyneBrowser({
    workspace,
    ensureBrowserCapability: async () => ({ ok: true }),
    resolveRuntime: () => ({ source: 'environment', installDirectory: '/fake', resourceDirectory: '/fake' }),
    loadBrowserEngine: async () => ({ Camoufox: async () => { launched++; return session; } }),
    validateUrl: async value => new URL(value)
  });
  try {
    await assert.rejects(
      browser.run([{ type: 'listTabs' }], { workspace: otherWorkspace }),
      /must match the isolated browser session workspace/
    );
    assert.equal(launched, 0, 'foreign workspace must fail before browser startup');
    await browser.run([{ type: 'listTabs' }]);
    assert.equal(launched, 1);
    assert.throws(() => browser.setWorkspace(otherWorkspace), /Cannot switch the workspace of an active browser session/);
    assert.equal(browser.getWorkspace(), workspace);
  } finally {
    await browser.close();
  }
});

test('unopened browser migration rotates profile and clears local host approvals', () => {
  const a = path.resolve(process.cwd(), 'workspace-before');
  const b = path.resolve(process.cwd(), 'workspace-after');
  const browser = new CausyneBrowser({ workspace: a });
  const oldProfile = (browser as any).profileDirectory;
  (browser as any).approvedLoopbackOrigins.add('http://localhost:1234');
  browser.setWorkspace(b);
  assert.equal(browser.getWorkspace(), b);
  assert.notEqual((browser as any).profileDirectory, oldProfile);
  assert.equal((browser as any).approvedLoopbackOrigins.size, 0);
});
