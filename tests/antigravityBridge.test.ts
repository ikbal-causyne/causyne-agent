import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { causyneHome } from '../src/utils/paths.js';
import { ensureAntigravityBridgeWorkspace, INFERENCE_AGENT_DEFINITION } from '../src/providers/antigravityBridge.js';

test('managed peer profile is tool-less, repeatable, and confined to Causyne adapter state', () => {
  const root = ensureAntigravityBridgeWorkspace();
  assert.ok(root.startsWith(path.join(causyneHome(), 'provider-bridges') + path.sep));
  assert.notEqual(root, process.cwd());
  const file = path.join(root, '.agents', 'agents', 'causyne-inference.md');
  assert.equal(fs.readFileSync(file, 'utf8'), INFERENCE_AGENT_DEFINITION);
  assert.match(INFERENCE_AGENT_DEFINITION, /tools: \[\]/);
  assert.match(INFERENCE_AGENT_DEFINITION, /inheritMcp: false/);
  assert.match(INFERENCE_AGENT_DEFINITION, /commandExecutionPolicy: off/);
  const before = fs.statSync(file).mtimeMs;
  assert.equal(ensureAntigravityBridgeWorkspace(), root);
  assert.equal(fs.statSync(file).mtimeMs, before);
});

test('a replaced managed profile cannot redirect writes through a symlink', { skip: process.platform === 'win32' }, () => {
  const root = ensureAntigravityBridgeWorkspace();
  const file = path.join(root, '.agents', 'agents', 'causyne-inference.md');
  const target = path.join(causyneHome(), 'untouched.txt');
  fs.writeFileSync(target, 'User content');
  fs.unlinkSync(file);
  fs.symlinkSync(target, file);
  try {
    assert.throws(() => ensureAntigravityBridgeWorkspace(), /must not be a symlink/);
    assert.equal(fs.readFileSync(target, 'utf8'), 'User content');
  } finally { fs.unlinkSync(file); }
});
