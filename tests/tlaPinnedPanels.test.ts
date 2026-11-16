import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const spec = fs.readFileSync(path.join(root, 'formal/CausynePinnedPanels.tla'), 'utf8');
const cfg = fs.readFileSync(path.join(root, 'formal/CausynePinnedPanels.cfg'), 'utf8');

test('pinned panel TLA+ model names the actual Causyne lifecycle events', () => {
  for (const action of ['OpenUsage', 'OpenStatus', 'ClosePanel', 'Submit', 'BeginRun', 'FinishRun']) {
    assert.match(spec, new RegExp('\\b' + action + '\\b'));
  }
  assert.match(spec, /PinnedUntilClose/);
  assert.match(spec, /NoRunInterruptFromPanel/);
  assert.match(cfg, /INVARIANT PinnedUntilClose/);
  assert.match(cfg, /INVARIANT TypeOK/);
});

test('TLC runner fails explicitly rather than pretending a proof exists without the checker', () => {
  const run = spawnSync(process.execPath, ['scripts/verify-tla.mjs'], {
    cwd: root, encoding: 'utf8', timeout: 2000,
    env: { ...process.env, CAUSYNE_TLC_JAR: '' }
  });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /TLC not executed/);
});
