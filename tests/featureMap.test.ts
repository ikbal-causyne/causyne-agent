import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { FEATURE_MAP, selectFeatures } from '../src/verification/featureMap.js';

test('feature map binds Causyne features to real checked-in executable tests', () => {
  const root = process.cwd();
  for (const [id, feature] of Object.entries(FEATURE_MAP)) {
    assert.match(id, /^[a-z][a-z-]+$/);
    assert.ok(feature.entry.length > 5 && feature.action.length > 10);
    assert.ok(feature.assertion.length > 10);
    assert.ok(feature.liveRequired.length > 10);
    assert.ok(feature.automated.length > 0);
    for (const testFile of feature.automated) {
      assert.ok(fs.existsSync(path.join(root, testFile)), 'missing test path: ' + testFile);
    }
  }
});

test('feature selection is deterministic, de-duplicates, and rejects unknown names', () => {
  const chosen = selectFeatures(['tui-usage', 'tui-usage', 'formal-state']);
  assert.deepEqual(chosen.map(x => x.id), ['tui-usage', 'formal-state']);
  assert.throws(() => selectFeatures(['unknown']), /Unknown feature/);
  assert.throws(() => selectFeatures([]), /At least one/);
});

test('verification surface classifications never masquerade as live UI proof', () => {
  for (const feature of Object.values(FEATURE_MAP)) {
    assert.ok(feature.liveRequired);
    assert.ok(['terminal','agent','browser','plugin','model'].includes(feature.surface));
  }
});
