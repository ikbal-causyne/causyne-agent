import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CausyneBrowser, BrowserBatchError } from '../src/browser/causyneBrowser.js';
import { browserAct } from '../src/tools/browserAutomator.js';

test('browser failures retain exact completed prefix and failing step metadata', async () => {
  let currentUrl = 'about:blank';
  const page = {
    isClosed: () => false,
    url: () => currentUrl,
    setDefaultTimeout() {},
    async route() {},
    on() {},
    async goto(url) { currentUrl = url; return { status: () => 200 }; },
    async waitForLoadState() {},
    async title() { return 'test'; },
    async close() {}
  };
  const session = { pages: () => [page], async newPage() {return page;}, async close(){} };
  const browser = new CausyneBrowser({
    workspace:process.cwd(), ensureBrowserCapability:async()=>({ok:true}),
    resolveRuntime:()=>({source:'environment',installDirectory:'/fake',resourceDirectory:'/fake'}),
    loadBrowserEngine:async()=>({Camoufox:async()=>session}),
    validateUrl:async value=>new URL(value)
  });
  try {
    await assert.rejects(
      browser.run([{type:'goto',url:'https://example.org/one'},{type:'click',selector:'#missing'}]),
      error => {
        assert.ok(error instanceof BrowserBatchError);
        assert.equal(error.failedActionIndex,1);
        assert.equal(error.failedActionType,'click');
        assert.deepEqual(error.completedActions.map(x=>x.action),['goto']);
        assert.equal(error.completedActions[0].url,'https://example.org/one');
        return true;
      }
    );
  } finally {await browser.close();}
});

test('agent-facing browser tool reports partial failure rather than hiding prior actions', async () => {
  const original = CausyneBrowser.prototype.run;
  CausyneBrowser.prototype.run = async () => {
    throw new BrowserBatchError(new Error('click failed'), [{action:'goto',url:'https://example.org'}], 1, 'click');
  };
  try {
    const response = await browserAct.execute({actions:[{type:'goto',url:'https://example.org'},{type:'click',selector:'button'}]});
    assert.equal(response.success,false);
    assert.equal(response.code,'BROWSER_BATCH_PARTIAL_FAILURE');
    assert.equal(response.completedActions.length,1);
    assert.equal(response.failedActionIndex,1);
    assert.match(response.retryGuidance,/Do not repeat/);
  } finally {CausyneBrowser.prototype.run=original;}
});
