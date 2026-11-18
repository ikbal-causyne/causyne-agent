import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CausyneBrowser } from '../src/browser/causyneBrowser.js';

function routeFor(url: string, frameUrl: string, navigation = false) {
  let decision: string | null = null;
  return {
    request: () => ({
      url: () => url,
      frame: () => ({ url: () => frameUrl }),
      isNavigationRequest: () => navigation
    }),
    continue: async () => { decision = 'allow'; },
    abort: async () => { decision = 'block'; },
    decision: () => decision
  };
}
test('public browser pages cannot fetch localhost services or file URLs', async () => {
  const browser = new CausyneBrowser({validateUrl: async input => new URL(input)});
  const publicToLocal = routeFor('http://127.0.0.1:4567/admin', 'https://example.org/home');
  await (browser as any).guardRoute(publicToLocal);
  assert.equal(publicToLocal.decision(), 'block');
  const publicToFile = routeFor('file:///tmp/secret.txt', 'https://example.org/home');
  await (browser as any).guardRoute(publicToFile);
  assert.equal(publicToFile.decision(), 'block');
});
test('explicit local development navigation permits same-origin assets, never foreign pages', async () => {
  const browser = new CausyneBrowser({validateUrl: async input => new URL(input)});
  const local = 'http://localhost:4567/';
  const page = {
    current: 'about:blank', url() { return this.current; },
    async goto(url: string) {
      const initial = routeFor(url, 'about:blank', true);
      await (browser as any).guardRoute(initial);
      assert.equal(initial.decision(), 'allow');
      this.current = url;
      return {status:()=>200};
    },
    async waitForLoadState() {}
  };
  const state = {page,refs:new Map(),runtimeErrors:[],lastSnapshot:'',lastStructure:null};
  await (browser as any).navigate(state, local);
  const resource = routeFor('http://localhost:4567/app.js', local);
  await (browser as any).guardRoute(resource);
  assert.equal(resource.decision(), 'allow');
  const crossOrigin = routeFor('http://localhost:4567/admin', 'https://example.org/');
  await (browser as any).guardRoute(crossOrigin);
  assert.equal(crossOrigin.decision(), 'block');
  browser.setWorkspace(process.cwd() + '/different-workspace');
  await (browser as any).guardRoute(resource);
  assert.equal(resource.decision(), 'block');
});
