import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectBrowserToolEvidence, isRenderedNativeBrowserAction } from '../src/observer/evidence.js';

test('only completed native browser render actions can count as browser inspection', () => {
  for (const action of ['browser_act', 'preview', 'snapshot', 'BROWSER_ACT']) {
    assert.equal(isRenderedNativeBrowserAction(action), true);
  }
  for (const action of ['web_fetch', 'browse', 'scrape', 'fs_read', 'sysRun', '']) {
    assert.equal(isRenderedNativeBrowserAction(action), false, action);
  }
});

test('agent loop browser verification requires observed DOM content, not merely an open tab or screenshot', () => {
  const notInspection = [
    { success: true, data: [{ action: 'listTabs', data: [{ url: 'https://example.org' }] }] },
    { success: true, data: [{ action: 'goto', tabId: 'tab1', url: 'https://example.org' }] },
    { success: true, data: [{ action: 'preview', tabId: 'tab1' }] },
    { success: true, data: [{ action: 'screenshot', output: 'Screenshot saved.' }] },
    { success: false, data: [{ action: 'snapshot', output: '- heading "OK"' }] }
  ];
  for (const candidate of notInspection) assert.equal(inspectBrowserToolEvidence(candidate).verified, false);
  assert.equal(inspectBrowserToolEvidence({
    success: true, data: [{ action: 'snapshot', output: '- heading "Page"' }]
  }).verified, true);
  const failing = inspectBrowserToolEvidence({
    success: true, data: [{ action: 'snapshot', output: '- heading "Page"',
      data: { runtimeErrors: ['Uncaught Error: crashed'] } }]
  });
  assert.equal(failing.verified, false);
  assert.deepEqual(failing.runtimeErrors, ['Uncaught Error: crashed']);
});
