import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkspacePreview } from '../src/browser/workspacePreview.js';

test('malformed browser interception URLs fail closed without throwing', async () => {
  const preview = new WorkspacePreview();
  for (const input of ['', 'not a URL', 'http://[', '://broken']) {
    assert.equal(await preview.response(input), null);
  }
});
