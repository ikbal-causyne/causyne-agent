import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getAvailableProvidersOverview, saveCachedModels } from '../src/dynamicCatalogue.js';
import { buildModelPickerItems } from '../src/tui/modelPicker.js';

test('a saved retired ACP model cannot re-enter a fresh peer model list or picker', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-retired-model-'));
  const previousCausyneHome = process.env.CAUSYNE_HOME;
  const config = { provider: 'acp/opencode', model: 'provider/retired-model' };

  try {
    process.env.CAUSYNE_HOME = tempDir;
    saveCachedModels('acp/opencode', ['provider/new-model']);

    const overview = getAvailableProvidersOverview(config);
    const peer = overview.acp.find((item) => item.providerKey === 'acp/opencode');
    assert.ok(peer);
    assert.deepEqual(peer.models, ['provider/new-model']);

    // The picker only renders installed peers; set that condition without relying
    // on the test machine having OpenCode installed.
    peer.installed = true;
    const items = buildModelPickerItems(config, overview)
      .filter((item) => item.value.providerId === 'acp/opencode');
    assert.deepEqual(items.map((item) => item.value.modelId), ['provider/new-model']);
    assert.equal(items[0]?.value.isCurrent, false);
  } finally {
    if (previousCausyneHome === undefined) delete process.env.CAUSYNE_HOME;
    else process.env.CAUSYNE_HOME = previousCausyneHome;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
