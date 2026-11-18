import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CausyneBrowser, validateBrowserActSandbox } from '../src/browser/causyneBrowser.js';

function fixture({ covered = false, visible = true } = {}) {
  const clicks: Array<Record<string, unknown>> = [];
  let evaluated = 0;
  let selectors = 0;
  const page = {
    isClosed: () => false,
    url: () => 'https://example.org',
    title: async () => 'Consent Test',
    setDefaultTimeout() {},
    async route() {},
    on() {},
    async waitForTimeout() {},
    async evaluate() { evaluated++; return true; },
    locator() {
      selectors++;
      return {
        first() { return this; },
        async isVisible() { return visible; },
        async click(options: Record<string, unknown>) {
          clicks.push(options);
          if (covered) throw new Error('another element intercepts pointer events');
        }
      };
    },
    async close() {}
  };
  const session = {
    pages: () => [page],
    newPage: async () => page,
    async close() {}
  };
  const browser = new CausyneBrowser({
    ensureBrowserCapability: async () => ({ ok: true }),
    resolveRuntime: () => ({ source: 'environment', installDirectory: '/mock', resourceDirectory: '/mock' }),
    loadBrowserEngine: async () => ({ Camoufox: async () => session }),
    validateUrl: async value => new URL(value)
  });
  return { browser, clicks, get evaluated() { return evaluated; }, get selectors() { return selectors; } };
}

test('consent dismissal never retries an occluded button with force or DOM click', async () => {
  const f = fixture({ covered: true });
  try {
    await assert.rejects(
      f.browser.run([{ type: 'wait', timeout: 50, dismissConsent: true }]),
      /intercepts pointer events/
    );
    assert.equal(f.clicks.length, 1);
    assert.equal(f.clicks[0]?.force, undefined);
    assert.equal(f.clicks[0]?.timeout, 12_000);
  } finally {
    await f.browser.close();
  }
});

test('explicit consent dismissal is a single Playwright action with accurate reporting', async () => {
  const f = fixture();
  try {
    const result = await f.browser.run([{ type: 'wait', timeout: 50, dismissConsent: true }]);
    assert.match(result[0]?.output ?? '', /consent banner dismissed/);
    assert.equal(f.clicks.length, 1);
  } finally {
    await f.browser.close();
  }
});

test('no consent selector is clicked when dismissal was not requested', async () => {
  const f = fixture();
  try {
    const result = await f.browser.run([{ type: 'wait', timeout: 50 }]);
    assert.equal(result[0]?.output, 'Wait completed');
    assert.equal(f.clicks.length, 0);
  } finally {
    await f.browser.close();
  }
});

test('consent-dismissing waits require the same authorization risk as other website clicks', () => {
  const validate = (actions: Array<Record<string, unknown>>) => validateBrowserActSandbox(
    { actions }, process.cwd(), () => false, () => true
  );
  assert.equal(validate([{ type: 'wait', dismissConsent: true }]).risk, 'dangerous');
  assert.equal(validate([{ type: 'wait', dismissConsent: false }]).risk, 'safe');
  assert.equal(validate([{ type: 'wait' }]).risk, 'safe');
});
