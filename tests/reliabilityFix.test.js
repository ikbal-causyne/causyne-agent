import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { NetworkHostGuard } from '../src/reliability/networkHostGuard.js';
import { inspectRequestedImageAssets } from '../src/reliability/assetEvidence.js';

async function withTemp(task) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'causyne-reliability-'));
  try { return await task(directory); } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

test('host breaker rejects the third timeout to the same image host', () => {
  const guard = new NetworkHostGuard();
  const args = { command: 'curl -sL https://images.unsplash.com/photo-1?w=1200 -o a.jpg' };
  assert.equal(guard.before('sysRun', args).allowed, true);
  guard.after('sysRun', args, { success: false, error: 'Process timed out after 60000ms' });
  guard.after('sysRun', args, { success: false, error: 'ETIMEDOUT' });
  assert.equal(guard.before('sysRun', args).allowed, false);
  assert.equal(guard.before('sysRun', { command: 'curl https://other.example.com/x' }).allowed, true);
  assert.equal(guard.before('fs_write', args).allowed, true);
  guard.reset();
  assert.equal(guard.before('sysRun', args).allowed, true);
});

test('guard only records recognized transient network errors and success clears host', () => {
  const guard = new NetworkHostGuard();
  const args = { command: 'curl https://source.unsplash.com/1920x1080 -o picture.jpg' };
  guard.after('sysRun', args, { success: false, error: 'HTTP 404' });
  guard.after('sysRun', args, { success: false, error: 'timed out' });
  assert.equal(guard.before('sysRun', args).allowed, true);
  guard.after('sysRun', args, { success: true, output: 'downloaded' });
  assert.equal(guard.before('sysRun', args).allowed, true);
});

test('image request with only nonexistent references is not complete', async () => withTemp(async root => {
  const file = path.join(root, 'project', 'index.html');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '<img src="assets/images/travel-hero.jpg">');
  const result = await inspectRequestedImageAssets({
    prompt: 'Build a traveler website with real pictures searching web, grab, download and apply',
    workspaceRoot: root, webArtifacts: [file]
  });
  assert.equal(result.ok, false);
  assert.match(result.reason, /no verified local image/i);
}));

test('image asset must have a matching signature, not just a jpg extension', async () => withTemp(async root => {
  const project = path.join(root, 'site');
  await fs.mkdir(path.join(project, 'assets'), { recursive: true });
  const file = path.join(project, 'index.html');
  await fs.writeFile(file, '<img src="assets/picture.jpg">');
  await fs.writeFile(path.join(project, 'assets/picture.jpg'), 'Fake JPEG content, not a real picture.');
  const result = await inspectRequestedImageAssets({
    prompt: 'Make a travel website, download and apply real images', workspaceRoot: root, webArtifacts: [file]
  });
  assert.equal(result.ok, false);
}));

test('genuine image bytes linked by HTML satisfy the downloaded-asset existence check', async () => withTemp(async root => {
  const project = path.join(root, 'site');
  await fs.mkdir(path.join(project, 'assets'), { recursive: true });
  const file = path.join(project, 'index.html');
  await fs.writeFile(file, '<img src="assets/photo.jpg">');
  const validJpeg = Buffer.concat([Buffer.from([0xff,0xd8,0xff,0xe0]), Buffer.alloc(64, 1)]);
  await fs.writeFile(path.join(project, 'assets/photo.jpg'), validJpeg);
  const result = await inspectRequestedImageAssets({
    prompt: 'Build a travel website, use real pictures from the web, download them',
    workspaceRoot: root, webArtifacts: [file]
  });
  assert.equal(result.ok, true);
  assert.equal(result.validImages, 1);
}));

test('generic websites without explicit image acquisition demand are not blocked', async () => {
  const result = await inspectRequestedImageAssets({
    prompt: 'Build a simple calculator website', workspaceRoot: '/missing', webArtifacts: []
  });
  assert.deepEqual(result, { ok: true, required: false });
});

test('image request cannot escape workspace via linked asset', async () => withTemp(async root => {
  const project = path.join(root, 'site');
  await fs.mkdir(project, { recursive: true });
  const file = path.join(project, 'index.html');
  await fs.writeFile(file, '<img src="../../outside.jpg">');
  const result = await inspectRequestedImageAssets({
    prompt: 'Build a travel site with real pictures grabbed and downloaded',
    workspaceRoot: root, webArtifacts: [file]
  });
  assert.equal(result.ok, false);
}));

// 3D/WebGL preview is not visually verified by a DOM snapshot alone.
import { inspect3DVisualEvidence } from '../src/reliability/visualEvidence.js';
test('3D screenshot must actually reach a vision-capable model', () => {
  const prompt = 'build a 3d horse robot in three.js';
  const outcomes = [
    { tool: 'fs_write', success: true },
    { tool: 'browser_act', success: true, rendered: true }
  ];
  assert.equal(inspect3DVisualEvidence(prompt, outcomes).ok, false);
  assert.equal(inspect3DVisualEvidence(prompt, [...outcomes, { tool: 'view_image', success: true, observedImage: true }]).ok, true);
  assert.equal(inspect3DVisualEvidence('Explain camera perspective math', outcomes).ok, true);
});

test('3D visual evidence must be newer than the latest workspace mutation', () => {
  const prompt = 'make a 3D interactive scene';
  const outcomes = [
    { tool: 'view_image', success: true, observedImage: true },
    { tool: 'fs_edit', success: true }
  ];
  assert.equal(inspect3DVisualEvidence(prompt, outcomes).ok, false);
});