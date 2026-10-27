import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { fsRead } from '../src/tools/fsRead.js';
import { viewImage } from '../src/tools/viewImage.js';
import { determineToolScope } from '../src/smartToolsUse.js';

test('binaryGuard: fsRead reads ordinary text files cleanly with line paging', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-fsread-test-'));
  const txtPath = path.join(tmpDir, 'hello.txt');
  fs.writeFileSync(txtPath, 'Hello world\nLine 2\nLine 3');

  try {
    const res = await fsRead.execute({ path: txtPath });
    assert.equal(res.success, true);
    assert.ok(res.output?.includes('Hello world'));
    assert.ok(res.output?.includes('Line 3'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('binaryGuard: fsRead rejects PNG image files and refuses to dump binary tokens', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-binary-test-'));
  const pngPath = path.join(tmpDir, 'test_apple.png');
  // Minimal 1x1 valid PNG binary buffer
  const minimalPng = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
    0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
    0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82
  ]);
  fs.writeFileSync(pngPath, minimalPng);

  try {
    const res = await fsRead.execute({ path: pngPath });
    assert.equal(res.success, false, 'fsRead must refuse to read PNG as text');
    assert.equal(res.isBinary, true, 'Must flag isBinary: true');
    assert.ok(res.error?.includes('Cannot read image file'), 'Must report image error guidance');
    assert.ok(res.error?.includes('view_image'), 'Must guide user/agent to view_image');
    assert.equal(res.output, undefined, 'Must not output binary content');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('binaryGuard: fsRead rejects 3D binary files (.blend, .glb)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-3d-binary-test-'));
  const blendPath = path.join(tmpDir, 'scene.blend');
  fs.writeFileSync(blendPath, Buffer.from('BLENDER_V400_BINARY_DATA\x00\x00\x01\x02'));

  try {
    const res = await fsRead.execute({ path: blendPath });
    assert.equal(res.success, false);
    assert.equal(res.isBinary, true);
    assert.ok(res.error?.includes('Cannot read binary file'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('visionRouting: viewImage processes images and returns native vision marker', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-viewimage-test-'));
  const pngPath = path.join(tmpDir, 'apple.png');
  const minimalPng = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
    0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41,
    0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
    0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
    0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
    0x42, 0x60, 0x82
  ]);
  fs.writeFileSync(pngPath, minimalPng);

  try {
    const res = await viewImage.execute({ path: pngPath });
    assert.equal(res.success, true);
    assert.equal(res._is_image_marker, true, 'Must return _is_image_marker for vision provider integration');
    assert.ok(typeof res.base64 === 'string' && res.base64.length > 0, 'Must produce base64 payload');
    assert.equal(res.filename, 'apple.png');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('smartToolsUse: media generation intent activates 3D/media scope and suppresses unneeded packs', () => {
  const prompt = 'buatkan aku 3d di blender simple 3d aplle red apple';
  const scope = determineToolScope(prompt);

  assert.equal(scope.archetype, 'media_3d_generation');
  assert.ok(scope.toolScope !== null, 'toolScope must be populated');
  assert.ok(scope.toolScope.has('blender_act'), 'Must include blender_act');
  assert.ok(scope.toolScope.has('creative_apps'), 'Must include creative_apps');
  assert.ok(scope.toolScope.has('view_image'), 'Must include view_image');
  assert.ok(scope.suppressedPacks.includes('web'), 'Must suppress web pack');
  assert.ok(scope.suppressedPacks.includes('game'), 'Must suppress game pack');
});
