import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceFileIndex } from '../src/tui/workspaceFileIndex.js';
import { suggest, applyCompletion, score } from '../src/tui/completion.js';

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-mention-index-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name, data = 'example') => {
    const absolute = path.join(root, name);
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, data);
  };
  write('HOLD/chatbox-tui/CausyneChatbox_FULL_SOURCE.md');
  write('src/deep/nested/box.ts');
  write('app/maxLevel/axial-layer.ts');
  write('packages/mobile/syntaxCheck.ts');
  write('packages/core/maxwell.ts');
  write('assets/my wallpaper.png');
  write('node_modules/example/ax.js');
  write('dist/generated-ax.js');
  write('.github/workflows/build.yml');
  return { root, write };
}

test('one @ query searches nested filenames across the active root without folder drilling', async t => {
  const { root } = workspace(t);
  const index = new WorkspaceFileIndex(root);
  await index.ensure();
  const completion = suggest('apply @CausyneChat', 'apply @CausyneChat'.length, { root, index });
  assert.ok(completion);
  assert.equal(completion.items[0].value, 'HOLD/chatbox-tui/CausyneChatbox_FULL_SOURCE.md');
  const applied = applyCompletion('apply @CausyneChat', 18, completion, completion.items[0]);
  assert.equal(applied.text, 'apply @HOLD/chatbox-tui/CausyneChatbox_FULL_SOURCE.md ');
});

test('substring @ax includes deeply nested paths and basename matches sort first', async t => {
  const { root } = workspace(t);
  const index = new WorkspaceFileIndex(root);
  await index.ensure();
  const completion = suggest('@ax', 3, { root, index });
  assert.ok(completion);
  const values = completion.items.map(item => item.value);
  assert.ok(values.includes('app/maxLevel/axial-layer.ts'));
  assert.ok(values.includes('packages/core/maxwell.ts'));
  assert.ok(values.includes('packages/mobile/syntaxCheck.ts'));
  assert.ok(values.indexOf('packages/core/maxwell.ts') < values.indexOf('packages/mobile/syntaxCheck.ts'));
  assert.ok(score('a/b/maxwell.ts', 'ax') > score('packages/mobile/syntaxCheck.ts', 'ax'));
});

test('index excludes external symlinks and costly generated folders', async t => {
  const { root } = workspace(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-mention-private-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.writeFileSync(path.join(outside, 'private-secret-ax.txt'), 'secret');
  try { fs.symlinkSync(outside, path.join(root, 'shortcut'), 'dir'); }
  catch { /* OS policy may forbid symlinks */ }
  const index = new WorkspaceFileIndex(root);
  await index.ensure();
  assert.ok(index.entries.every(name => !name.includes('node_modules') && !name.includes('dist/')));
  assert.ok(index.entries.every(name => !name.includes('private-secret')));
  assert.ok(index.entries.every(name => !name.startsWith('shortcut/')));
});

test('index notifies once per completed scan and refreshes after files are added', async t => {
  const { root, write } = workspace(t);
  const index = new WorkspaceFileIndex(root);
  let notifications = 0;
  index.subscribe(() => notifications++);
  await Promise.all([index.ensure(), index.ensure(), index.ensure()]);
  assert.equal(notifications, 1);
  write('another/deep/newMatchingAsset.png');
  await index.ensure(true);
  assert.equal(notifications, 2);
  assert.ok(index.candidates('matchingasset').includes('another/deep/newMatchingAsset.png'));
});

test('outdated workspace index does not update after dispose', async t => {
  const { root } = workspace(t);
  const index = new WorkspaceFileIndex(root);
  let notifications = 0;
  index.subscribe(() => notifications++);
  const running = index.ensure();
  index.dispose();
  await running;
  assert.equal(notifications, 0);
});

test('index advertises explicit truncation instead of claiming every path is indexed', async t => {
  const { root } = workspace(t);
  const index = new WorkspaceFileIndex(root, { maxEntries: 4 });
  await index.ensure();
  assert.equal(index.truncated, true);
  assert.ok(index.entries.length <= 4);
});

test('path with spaces remains quoted and is usable as @ context', async t => {
  const { root } = workspace(t);
  const index = new WorkspaceFileIndex(root);
  await index.ensure();
  const text = 'open @wallpaper';
  const completion = suggest(text, text.length, { root, index });
  assert.ok(completion);
  const target = completion.items.find(item => item.value === 'assets/my wallpaper.png');
  assert.ok(target);
  const completed = applyCompletion(text, text.length, completion, target);
  assert.equal(completed.text, 'open @"assets/my wallpaper.png" ');
});
