import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isRenderedNativeBrowserAction } from '../src/observer/evidence.js';

test('only completed native browser render actions can count as browser inspection', () => {
  for (const action of ['browser_act', 'preview', 'snapshot', 'BROWSER_ACT']) {
    assert.equal(isRenderedNativeBrowserAction(action), true);
  }
  for (const action of ['web_fetch', 'browse', 'scrape', 'fs_read', 'sysRun', '']) {
    assert.equal(isRenderedNativeBrowserAction(action), false, action);
  }
});
