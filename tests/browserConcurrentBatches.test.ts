import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CausyneBrowser } from '../src/browser/causyneBrowser.js';

function harness() {
  let page;
  let entered;
  let release;
  const enteredPromise = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const visited = [];
  const session = {
    pages: () => page ? [page] : [],
    async newPage() {
      page = {
        isClosed: () => false, url: () => page.currentUrl, currentUrl: 'about:blank',
        setDefaultTimeout() {}, async route() {}, on() {},
        async goto(url) {
          visited.push(url); page.currentUrl = url;
          if (url.endsWith('/first')) { entered(); await gate; }
          return { status: () => 200 };
        },
        async waitForLoadState() {}, async title() { return 'title'; },
        locator: () => ({ ariaSnapshot: async () => '- heading "OK"' }),
        frames: () => [], async evaluate() { return [{ title: 'Result', url: 'https://example.org/result', snippet: 'OK' }]; },
        async waitForTimeout() {}, async close() {}
      };
      return page;
    },
    async close() {}
  };
  const browser = new CausyneBrowser({
    workspace: process.cwd(), ensureBrowserCapability: async () => ({ok:true}),
    resolveRuntime: () => ({source:'environment', installDirectory:'/fake', resourceDirectory:'/fake'}),
    loadBrowserEngine: async () => ({Camoufox: async () => session}),
    validateUrl: async value => new URL(value)
  });
  return {browser,visited,enteredPromise,release};
}
test('overlapping browser action batches never interleave a snapshot with another navigation', async () => {
  const {browser,visited,enteredPromise,release} = harness();
  const first=browser.run([{type:'goto',url:'https://example.org/first'},{type:'snapshot'}]);
  try {
    await enteredPromise;
    const second=browser.run([{type:'goto',url:'https://example.org/second'},{type:'snapshot'}]);
    await Promise.resolve();
    assert.deepEqual(visited,['https://example.org/first']);
    release();
    const [a,b]=await Promise.all([first,second]);
    assert.equal(a[1].url,'https://example.org/first');
    assert.equal(b[1].url,'https://example.org/second');
    assert.deepEqual(visited,['https://example.org/first','https://example.org/second']);
  } finally {
    release();
    await browser.close();
  }
});
test('browser search action inside a locked browser batch does not deadlock',async()=>{
  const {browser,release}=harness();
  release();
  try {
    const result = await browser.run([{type:'search',query:'test'}]);
    assert.equal(result[0].action,'search');
    assert.equal(result[0].data[0].url,'https://example.org/result');
  } finally {await browser.close();}
});
