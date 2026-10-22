import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { causyneHome } from '../src/utils/paths.js';
import { nativeEngineTool } from '../src/tools/nativeEngine.js';
import { resolveTool } from '../src/tools/registry.js';
import { isMutatingToolCall } from '../src/decisionPolicy.js';
import { Sandbox } from '../src/sandbox.js';

const FAKE = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const known = ['commands','describe','inspect','exec','run','export','render','probe'];
const command = args.find(arg => known.includes(arg));
let stdin = '';
if (command === 'run') stdin = fs.readFileSync(0, 'utf8');
fs.appendFileSync(path.join(__dirname, 'engine.log'), JSON.stringify({ args, stdin }) + '\\n');
if (args.includes('--version')) { console.log('causyne-engine-film 0.1.0'); process.exit(0); }
const value = key => { const i = args.indexOf(key); return i >= 0 ? args[i + 1] : undefined; };
if (command === 'commands') {
  console.log(JSON.stringify([{ id: 'timeline.razor', label: 'Razor' }]));
} else if (command === 'describe') {
  console.log(JSON.stringify({ id: args[args.indexOf('describe') + 1], params: ['seconds'] }));
} else if (command === 'inspect') {
  console.log(JSON.stringify({ project: { name: 'fake' }, sequence: { tracks: [] } }));
} else if (command === 'exec') {
  const id = args[args.indexOf('exec') + 1];
  const params = JSON.parse(args[args.indexOf('exec') + 2] || '{}');
  console.log(JSON.stringify({ ok: true, id, params }));
} else if (command === 'run') {
  stdin.split(/\\r?\\n/).filter(Boolean).forEach((line, index) => {
    const step = JSON.parse(line);
    console.log(JSON.stringify({ line: index + 1, id: step.id, ok: true }));
  });
} else if (command === 'export' || command === 'render') {
  const out = command === 'export' ? args[args.indexOf('export') + 1] : value('--out');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, 'artifact');
  console.log(JSON.stringify({ path: out }));
} else if (command === 'probe') {
  console.log(JSON.stringify({ format: 'fake', duration: 1 }));
}
`;

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'causyne-engine-test-'));
  const binary = path.join(root, 'engine');
  const log = path.join(root, 'engine.log');
  await fs.writeFile(binary, FAKE, { mode: 0o755 });
  process.env.CAUSYNE_ENGINE_FILM = binary;
  return { root, binary, log };
}

async function cleanup(root) {
  delete process.env.CAUSYNE_ENGINE_FILM;
  await fs.rm(root, { recursive: true, force: true });
}

test('native engine tool is registered and classified', () => {
  assert.equal(resolveTool('native_engine'), nativeEngineTool);
  assert.equal(isMutatingToolCall('native_engine', { action: 'status' }), false);
  assert.equal(isMutatingToolCall('native_engine', { action: 'execute' }), true);
  assert.equal(isMutatingToolCall('native_engine', { action: 'install' }), true);
  const sandbox = new Sandbox();
  assert.equal(sandbox.validate('native_engine', { action: 'inspect' }).risk, 'safe');
  assert.equal(sandbox.validate('native_engine', { action: 'execute' }).risk, 'dangerous');
  assert.equal(sandbox.validate('native_engine', { action: 'install' }).risk, 'extreme');
});

test('native engine reports an installation hint when absent', async () => {
  delete process.env.CAUSYNE_ENGINE_FILM;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'causyne-engine-missing-'));
  try {
    const result = await nativeEngineTool.execute({ action: 'status' }, { workspacePaths: [root] });
    assert.equal(result.success, true);
    assert.equal(result.engines[0].id, 'film');
    assert.equal(result.engines[0].installed, false);
    assert.equal(result.engines[0].envVar, 'CAUSYNE_ENGINE_FILM');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('native engine drives catalog, describe, inspect, execute, batch, render, export and probe without MCP', async () => {
  const { root, log } = await fixture();
  try {
    const context = { workspacePaths: [root] };
    const status = await nativeEngineTool.execute({ action: 'status' }, context);
    assert.equal(status.engines[0].installed, true);
    assert.equal(status.engines[0].version, '0.1.0');

    const catalog = await nativeEngineTool.execute({ action: 'catalog', query: 'razor' }, context);
    assert.equal(catalog.success, true);
    assert.equal(catalog.data[0].id, 'timeline.razor');

    const described = await nativeEngineTool.execute({ action: 'describe', command: 'timeline.razor' }, context);
    assert.equal(described.success, true);
    assert.equal(described.data.id, 'timeline.razor');

    const inspected = await nativeEngineTool.execute({ action: 'inspect', query: 'sequence' }, context);
    assert.equal(inspected.success, true);
    assert.deepEqual(inspected.data.sequence.tracks, []);

    const executed = await nativeEngineTool.execute({
      action: 'execute', command: 'timeline.razor', params: { seconds: 2 }
    }, context);
    assert.equal(executed.success, true);
    assert.deepEqual(executed.data, { ok: true, id: 'timeline.razor', params: { seconds: 2 } });

    const batch = await nativeEngineTool.execute({
      action: 'batch',
      steps: [{ id: 'timeline.razor', params: { seconds: 1 } }, { id: 'sequence.inspect' }]
    }, context);
    assert.equal(batch.success, true);
    assert.equal(batch.lines.length, 2);

    const rendered = await nativeEngineTool.execute({
      action: 'render', output: 'frames/frame.png', seconds: 1.5
    }, context);
    assert.equal(rendered.success, true);
    assert.deepEqual(rendered.artifacts, ['frames/frame.png']);
    assert.equal(await fs.readFile(path.join(root, 'frames/frame.png'), 'utf8'), 'artifact');

    const exported = await nativeEngineTool.execute({ action: 'export', output: 'out.mp4' }, context);
    assert.equal(exported.success, true);
    assert.deepEqual(exported.artifacts, ['out.mp4']);

    const probed = await nativeEngineTool.execute({ action: 'probe', query: 'frames/frame.png' }, context);
    assert.equal(probed.success, true);
    assert.equal(probed.data.format, 'fake');

    const calls = (await fs.readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(calls.some(call => call.args.includes('commands') && call.args.includes('--json')));
    assert.ok(calls.some(call => call.args.includes('run') && call.stdin.includes('timeline.razor')));
    assert.ok(!calls.some(call => call.args.includes('mcp')));
  } finally {
    await cleanup(root);
  }
});

test('native engine rejects workspace escape, overwrite and malformed batches', async () => {
  const { root } = await fixture();
  try {
    const context = { workspacePaths: [root] };
    await fs.writeFile(path.join(root, 'existing.png'), 'keep');
    assert.equal((await nativeEngineTool.execute({ action: 'render', output: '../escape.png' }, context)).success, false);
    assert.equal((await nativeEngineTool.execute({ action: 'render', output: 'existing.png' }, context)).success, false);
    assert.equal((await nativeEngineTool.execute({ action: 'probe', query: '../escape.mp4' }, context)).success, false);
    assert.equal((await nativeEngineTool.execute({ action: 'batch', steps: Array.from({ length: 129 }, () => ({ id: 'x' })) }, context)).success, false);
    assert.equal((await nativeEngineTool.execute({ action: 'execute', command: 'timeline.razor', params: { path: '../outside.png' } }, context)).success, false);
    assert.equal((await nativeEngineTool.execute({ action: 'execute', command: 'timeline.razor', save: true }, context)).success, false);
    assert.equal((await fs.readFile(path.join(root, 'existing.png'), 'utf8')), 'keep');
  } finally {
    await cleanup(root);
  }
});


test('native engine install requires consent, verifies SHA-256, and becomes the selected binary', async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'causyne-engine-install-'));
  const installRoot = path.join(causyneHome(), 'engines', 'film');
  delete process.env.CAUSYNE_ENGINE_FILM;
  try {
    await fs.rm(installRoot, { recursive: true, force: true });
    const asset = path.join(workspace, 'causyne-engine-film');
    await fs.writeFile(asset, FAKE, { mode: 0o755 });
    const bytes = await fs.readFile(asset);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const platform = `${process.platform}-${process.arch}`;
    const manifest = path.join(workspace, 'engines.json');
    const writeManifest = async (version, sha256) => {
      await fs.writeFile(manifest, JSON.stringify({
        schema: 1,
        engines: {
          film: {
            version,
            license: 'MIT OR Apache-2.0',
            platforms: {
              [platform]: { url: pathToFileURL(asset).href, sha256, size: bytes.length }
            }
          }
        }
      }));
    };
    await writeManifest('0.1.0', digest);
    process.env.CAUSYNE_ENGINE_MANIFEST = manifest;
    const context = { workspacePaths: [workspace] };

    const preview = await nativeEngineTool.execute({ action: 'install' }, context);
    assert.equal(preview.success, false);
    assert.equal(preview.requiresConsent, true);
    assert.equal(preview.version, '0.1.0');
    assert.equal(preview.size, bytes.length);
    assert.equal(preview.license, 'MIT OR Apache-2.0');
    await assert.rejects(fs.access(path.join(installRoot, 'current.json')));

    const installed = await nativeEngineTool.execute({ action: 'install', confirm: true }, context);
    assert.equal(installed.success, true);
    assert.equal(installed.installed, true);
    assert.equal(installed.alreadyInstalled, false);
    assert.ok((await fs.stat(path.join(installRoot, 'current.json'))).isFile());

    const status = await nativeEngineTool.execute({ action: 'status' }, context);
    assert.equal(status.engines[0].installed, true);
    assert.equal(status.engines[0].version, '0.1.0');
    const catalog = await nativeEngineTool.execute({ action: 'catalog' }, context);
    assert.equal(catalog.success, true);
    assert.equal(catalog.data[0].id, 'timeline.razor');
    const again = await nativeEngineTool.execute({ action: 'install', confirm: true }, context);
    assert.equal(again.success, true);
    assert.equal(again.alreadyInstalled, true);

    await writeManifest('0.2.0', '0'.repeat(64));
    const rejected = await nativeEngineTool.execute({ action: 'install', confirm: true }, context);
    assert.equal(rejected.success, false);
    assert.match(rejected.error, /SHA-256/);
    const pointer = JSON.parse(await fs.readFile(path.join(installRoot, 'current.json'), 'utf8'));
    assert.equal(pointer.version, '0.1.0');
  } finally {
    delete process.env.CAUSYNE_ENGINE_MANIFEST;
    delete process.env.CAUSYNE_ENGINE_FILM;
    await fs.rm(installRoot, { recursive: true, force: true });
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

const FAKE_PHOTO = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const verb = args[0];
fs.appendFileSync(path.join(__dirname, 'photo-engine.log'), JSON.stringify({ args }) + '\\n');
if (args.includes('--version')) { console.log('causyne-engine-photo 0.8.2'); process.exit(0); }
const value = key => { const i = args.indexOf(key); return i >= 0 ? args[i + 1] : undefined; };
if (verb === 'commands') {
  console.log(JSON.stringify([{ id: 'file.new', label: 'New…' }, { id: 'image.imageRotation.flipCanvasHorizontal', label: 'Flip Horizontal' }]));
} else if (verb === 'info') {
  console.log(JSON.stringify({ width: 1920, height: 1080, mode: 'Rgb', layers: [{ id: 1, name: 'Layer 1' }] }));
} else if (verb === 'run') {
  const out = value('--out');
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, 'photo-artifact');
  }
  console.log(JSON.stringify({ ok: true, out }));
} else if (verb === 'convert') {
  const out = args[2];
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, 'converted-photo');
  }
  console.log(JSON.stringify({ ok: true, out }));
}
`;

test('native photo engine drives catalog, describe, inspect, execute, export and render without MCP', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'causyne-photo-test-'));
  const binary = path.join(root, 'causyne-engine-photo');
  const log = path.join(root, 'photo-engine.log');
  await fs.writeFile(binary, FAKE_PHOTO, { mode: 0o755 });
  process.env.CAUSYNE_ENGINE_PHOTO = binary;
  try {
    const context = { workspacePaths: [root] };
    const status = await nativeEngineTool.execute({ engine: 'photo', action: 'status' }, context);
    const photo = status.engines.find(e => e.id === 'photo');
    assert.equal(photo.installed, true);
    assert.equal(photo.version, '0.8.2');

    const catalog = await nativeEngineTool.execute({ engine: 'photo', action: 'catalog' }, context);
    assert.equal(catalog.success, true);
    assert.equal(catalog.data[0].id, 'file.new');

    const executed = await nativeEngineTool.execute({
      engine: 'photo',
      action: 'execute',
      command: 'file.new',
      params: { width: 800, height: 600 },
      saveAs: 'canvas.png'
    }, context);
    assert.equal(executed.success, true);
    assert.deepEqual(executed.artifacts, ['canvas.png']);
    assert.equal(await fs.readFile(path.join(root, 'canvas.png'), 'utf8'), 'photo-artifact');

    const inspected = await nativeEngineTool.execute({
      engine: 'photo',
      action: 'inspect',
      project: 'canvas.png'
    }, context);
    assert.equal(inspected.success, true);
    assert.equal(inspected.data.width, 1920);

    const exported = await nativeEngineTool.execute({
      engine: 'photo',
      action: 'export',
      project: 'canvas.png',
      output: 'canvas.jpg',
      format: 'jpg',
      quality: 90
    }, context);
    assert.equal(exported.success, true);
    assert.deepEqual(exported.artifacts, ['canvas.jpg']);

    const calls = (await fs.readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(calls.some(call => call.args.includes('commands') && call.args.includes('--json')));
    assert.ok(calls.some(call => call.args.includes('run') && call.args.includes('--new')));
    assert.ok(!calls.some(call => call.args.includes('mcp')));
  } finally {
    delete process.env.CAUSYNE_ENGINE_PHOTO;
    await fs.rm(root, { recursive: true, force: true });
  }
});

const FAKE_SOUND = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const verb = args[0];
fs.appendFileSync(path.join(__dirname, 'sound-engine.log'), JSON.stringify({ args }) + '\\n');
if (args.includes('--version')) { console.log('causyne-engine-sound 0.6.1'); process.exit(0); }
const value = key => { const i = args.indexOf(key); return i >= 0 ? args[i + 1] : undefined; };
if (verb === 'commands') {
  console.log('edit.strip_silence                   Strip Silence                      Edit\\nedit.fades_create                    Create...                          Edit > Fades');
} else if (verb === 'describe') {
  console.log(JSON.stringify({ id: args[1], description: 'audio command' }));
} else if (verb === 'info') {
  console.log(JSON.stringify({ format: 'wav', sample_rate: 48000, channels: 2, seconds: 10.5 }));
} else if (verb === 'run') {
  const bounce = value('--bounce');
  const save = value('--save');
  if (bounce) {
    fs.mkdirSync(path.dirname(bounce), { recursive: true });
    fs.writeFileSync(bounce, 'sound-bounce');
  }
  if (save) {
    fs.mkdirSync(path.dirname(save), { recursive: true });
    fs.writeFileSync(save, 'sound-session');
  }
  console.log(JSON.stringify({ ok: true, bounce, save }));
} else if (verb === 'convert') {
  const out = args[2];
  if (out) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, 'sound-converted');
  }
  console.log(JSON.stringify({ ok: true, out }));
}
`;

test('native sound engine drives catalog, describe, inspect, execute, export and render without MCP', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'causyne-sound-test-'));
  const binary = path.join(root, 'causyne-engine-sound');
  const log = path.join(root, 'sound-engine.log');
  await fs.writeFile(binary, FAKE_SOUND, { mode: 0o755 });
  process.env.CAUSYNE_ENGINE_SOUND = binary;
  try {
    const context = { workspacePaths: [root] };
    const status = await nativeEngineTool.execute({ engine: 'sound', action: 'status' }, context);
    const sound = status.engines.find(e => e.id === 'sound');
    assert.equal(sound.installed, true);
    assert.equal(sound.version, '0.6.1');

    const catalog = await nativeEngineTool.execute({ engine: 'sound', action: 'catalog' }, context);
    assert.equal(catalog.success, true);
    assert.match(catalog.output, /strip_silence/);

    const executed = await nativeEngineTool.execute({
      engine: 'sound',
      action: 'execute',
      command: 'edit.strip_silence',
      demo: true,
      saveAs: 'session.scraft',
      output: 'mix.wav'
    }, context);
    assert.equal(executed.success, true);
    assert.ok(executed.artifacts.includes('session.scraft'));
    assert.ok(executed.artifacts.includes('mix.wav'));
    assert.equal(await fs.readFile(path.join(root, 'mix.wav'), 'utf8'), 'sound-bounce');

    const probed = await nativeEngineTool.execute({
      engine: 'sound',
      action: 'probe',
      query: 'mix.wav'
    }, context);
    assert.equal(probed.success, true);
    assert.equal(probed.data.sample_rate, 48000);

    const exported = await nativeEngineTool.execute({
      engine: 'sound',
      action: 'export',
      project: 'mix.wav',
      output: 'mix.mp3'
    }, context);
    assert.equal(exported.success, true);
    assert.deepEqual(exported.artifacts, ['mix.mp3']);

    const calls = (await fs.readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(calls.some(call => call.args.includes('commands')));
    assert.ok(calls.some(call => call.args.includes('run') && call.args.includes('--demo')));
    assert.ok(!calls.some(call => call.args.includes('mcp')));
  } finally {
    delete process.env.CAUSYNE_ENGINE_SOUND;
    await fs.rm(root, { recursive: true, force: true });
  }
});

const FAKE_CAD = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, 'cad-engine.log'), JSON.stringify({ args }) + '\\n');
if (args.includes('--version') || args.includes('-V')) {
  console.log('causyne-engine-cad 0.6.2');
  process.exit(0);
}
const sub = args[0];
if (sub === 'commands') {
  console.log(JSON.stringify([{ id: 'draw.line', label: 'Line' }, { id: 'draw.circle', label: 'Circle' }]));
} else if (sub === 'info') {
  console.log(JSON.stringify({ layers: 3, entities: 142, extents: [0, 0, 100, 100] }));
} else if (sub === 'run') {
  const saveIdx = args.indexOf('--save');
  if (saveIdx >= 0) {
    const savePath = args[saveIdx + 1];
    fs.mkdirSync(path.dirname(savePath), { recursive: true });
    fs.writeFileSync(savePath, 'dxf-saved');
  }
  const expIdx = args.indexOf('--export');
  if (expIdx >= 0) {
    const expPath = args[expIdx + 1];
    fs.mkdirSync(path.dirname(expPath), { recursive: true });
    fs.writeFileSync(expPath, 'cad-render');
  }
  console.log(JSON.stringify({ ok: true }));
} else if (sub === 'convert') {
  const out = args[2];
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, 'converted-cad');
  console.log(JSON.stringify({ ok: true, out }));
}
`;

test('native cad engine drives catalog, describe, inspect, execute, export and render without MCP', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'causyne-cad-test-'));
  const binary = path.join(root, 'causyne-engine-cad');
  const log = path.join(root, 'cad-engine.log');
  await fs.writeFile(binary, FAKE_CAD, { mode: 0o755 });
  process.env.CAUSYNE_ENGINE_CAD = binary;
  try {
    const context = { workspacePaths: [root] };
    const status = await nativeEngineTool.execute({ engine: 'cad', action: 'status' }, context);
    const cad = status.engines.find(e => e.id === 'cad');
    assert.equal(cad.installed, true);
    assert.equal(cad.version, '0.6.2');

    const catalog = await nativeEngineTool.execute({ engine: 'cad', action: 'catalog' }, context);
    assert.equal(catalog.success, true);
    assert.equal(catalog.data[0].id, 'draw.line');

    const executed = await nativeEngineTool.execute({
      engine: 'cad',
      action: 'execute',
      command: 'draw.line',
      params: { start: [0, 0], end: [10, 10] },
      demo: true,
      saveAs: 'model.dxf',
      output: 'model.png'
    }, context);
    assert.equal(executed.success, true);
    assert.ok(executed.artifacts.includes('model.dxf'));
    assert.ok(executed.artifacts.includes('model.png'));
    assert.equal(await fs.readFile(path.join(root, 'model.png'), 'utf8'), 'cad-render');

    const probed = await nativeEngineTool.execute({
      engine: 'cad',
      action: 'probe',
      query: 'model.dxf'
    }, context);
    assert.equal(probed.success, true);
    assert.equal(probed.data.layers, 3);

    const exported = await nativeEngineTool.execute({
      engine: 'cad',
      action: 'export',
      project: 'model.dxf',
      output: 'model.svg'
    }, context);
    assert.equal(exported.success, true);
    assert.deepEqual(exported.artifacts, ['model.svg']);

    const calls = (await fs.readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(calls.some(call => call.args.includes('commands')));
    assert.ok(calls.some(call => call.args.includes('run') && call.args.includes('--sample')));
    assert.ok(!calls.some(call => call.args.includes('mcp')));
  } finally {
    delete process.env.CAUSYNE_ENGINE_CAD;
    await fs.rm(root, { recursive: true, force: true });
  }
});

const FAKE_DECK = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, 'deck-engine.log'), JSON.stringify({ args }) + '\\n');
if (args.includes('--version')) {
  console.log('causyne-engine-deck 0.1.0');
  process.exit(0);
}
const sub = args[0];
if (sub === 'commands') {
  console.log(JSON.stringify([{ id: 'file.new', label: 'New Presentation' }, { id: 'slide.new', label: 'New Slide' }]));
} else if (sub === 'info') {
  console.log(JSON.stringify({ slides: 5, size: [1920, 1080], theme: 'dark' }));
} else if (sub === 'exec' || sub === 'run') {
  const saveIdx = args.indexOf('--save');
  if (saveIdx >= 0) {
    const savePath = args[saveIdx + 1];
    fs.mkdirSync(path.dirname(savePath), { recursive: true });
    fs.writeFileSync(savePath, 'deck-saved');
  }
  const expIdx = args.indexOf('--export');
  if (expIdx >= 0) {
    const expPath = args[expIdx + 1];
    fs.mkdirSync(path.dirname(expPath), { recursive: true });
    fs.writeFileSync(expPath, 'deck-exported');
  }
  console.log(JSON.stringify({ ok: true }));
} else if (sub === 'convert') {
  const out = args[2];
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, 'converted-deck');
  console.log(JSON.stringify({ ok: true, out }));
} else if (sub === 'render') {
  const out = args[args.length - 1];
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, 'rendered-slide');
  console.log(JSON.stringify({ ok: true, out }));
}
`;

test('native deck engine drives catalog, describe, inspect, execute, export and render without MCP', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'causyne-deck-test-'));
  const binary = path.join(root, 'causyne-engine-deck');
  const log = path.join(root, 'deck-engine.log');
  await fs.writeFile(binary, FAKE_DECK, { mode: 0o755 });
  process.env.CAUSYNE_ENGINE_DECK = binary;
  try {
    const context = { workspacePaths: [root] };
    const status = await nativeEngineTool.execute({ engine: 'deck', action: 'status' }, context);
    const deck = status.engines.find(e => e.id === 'deck');
    assert.equal(deck.installed, true);
    assert.equal(deck.version, '0.1.0');

    const catalog = await nativeEngineTool.execute({ engine: 'deck', action: 'catalog' }, context);
    assert.equal(catalog.success, true);
    assert.equal(catalog.data[0].id, 'file.new');

    const executed = await nativeEngineTool.execute({
      engine: 'deck',
      action: 'execute',
      command: 'slide.new',
      params: { title: 'Q4 Vision' },
      demo: true,
      saveAs: 'presentation.deck'
    }, context);
    assert.equal(executed.success, true);
    assert.ok(executed.artifacts.includes('presentation.deck'));
    assert.equal(await fs.readFile(path.join(root, 'presentation.deck'), 'utf8'), 'deck-saved');


    const probed = await nativeEngineTool.execute({
      engine: 'deck',
      action: 'probe',
      query: 'presentation.deck'
    }, context);
    assert.equal(probed.success, true);
    assert.equal(probed.data.slides, 5);

    const exported = await nativeEngineTool.execute({
      engine: 'deck',
      action: 'export',
      project: 'presentation.deck',
      output: 'presentation.pdf'
    }, context);
    assert.equal(exported.success, true);
    assert.deepEqual(exported.artifacts, ['presentation.pdf']);

    const rendered = await nativeEngineTool.execute({
      engine: 'deck',
      action: 'render',
      output: 'slide-1.png'
    }, context);
    assert.equal(rendered.success, true);
    assert.deepEqual(rendered.artifacts, ['slide-1.png']);
    assert.equal(await fs.readFile(path.join(root, 'slide-1.png'), 'utf8'), 'rendered-slide');

    const calls = (await fs.readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(calls.some(call => call.args.includes('commands')));
    assert.ok(calls.some(call => call.args.includes('exec') && call.args.includes('--sample')));
    assert.ok(calls.some(call => call.args.includes('render')));
    assert.ok(!calls.some(call => call.args.includes('mcp')));
  } finally {
    delete process.env.CAUSYNE_ENGINE_DECK;
    await fs.rm(root, { recursive: true, force: true });
  }
});

const FAKE_DESIGN = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, 'design-engine.log'), JSON.stringify({ args }) + '\\n');
if (args.includes('--version')) {
  console.log('causyne-engine-design 0.7.1');
  process.exit(0);
}
const sub = args[0];
if (sub === 'commands') {
  console.log(JSON.stringify([{ id: 'doc.new', label: 'New Document' }, { id: 'frame.new', label: 'New Frame' }]));
} else if (sub === 'run') {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--export' && args[i + 1] && args[i + 1] !== '/dev/null') {
      fs.mkdirSync(path.dirname(args[i + 1]), { recursive: true });
      fs.writeFileSync(args[i + 1], 'design-rendered');
    }
  }
  console.log(JSON.stringify({ ok: true, pages: 1 }));
}
`;

test('native design engine drives catalog, describe, inspect, execute, export and render without MCP', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'causyne-design-test-'));
  const binary = path.join(root, 'causyne-engine-design');
  const log = path.join(root, 'design-engine.log');
  await fs.writeFile(binary, FAKE_DESIGN, { mode: 0o755 });
  process.env.CAUSYNE_ENGINE_DESIGN = binary;
  try {
    const context = { workspacePaths: [root] };
    const status = await nativeEngineTool.execute({ engine: 'design', action: 'status' }, context);
    const design = status.engines.find(e => e.id === 'design');
    assert.equal(design.installed, true);
    assert.equal(design.version, '0.7.1');

    const catalog = await nativeEngineTool.execute({ engine: 'design', action: 'catalog' }, context);
    assert.equal(catalog.success, true);
    assert.equal(catalog.data[0].id, 'doc.new');

    const executed = await nativeEngineTool.execute({
      engine: 'design',
      action: 'execute',
      command: 'frame.new',
      params: { width: 500, height: 500 },
      demo: true,
      saveAs: 'flyer.designcraft',
      output: 'flyer.pdf'
    }, context);
    assert.equal(executed.success, true);
    assert.ok(executed.artifacts.includes('flyer.designcraft'));
    assert.ok(executed.artifacts.includes('flyer.pdf'));
    assert.equal(await fs.readFile(path.join(root, 'flyer.pdf'), 'utf8'), 'design-rendered');

    const probed = await nativeEngineTool.execute({
      engine: 'design',
      action: 'probe',
      query: 'flyer.designcraft'
    }, context);
    assert.equal(probed.success, true);

    const exported = await nativeEngineTool.execute({
      engine: 'design',
      action: 'export',
      project: 'flyer.designcraft',
      output: 'flyer-final.pdf'
    }, context);
    assert.equal(exported.success, true);
    assert.deepEqual(exported.artifacts, ['flyer-final.pdf']);

    const rendered = await nativeEngineTool.execute({
      engine: 'design',
      action: 'render',
      output: 'page-1.png'
    }, context);
    assert.equal(rendered.success, true);
    assert.deepEqual(rendered.artifacts, ['page-1.png']);
    assert.equal(await fs.readFile(path.join(root, 'page-1.png'), 'utf8'), 'design-rendered');

    const calls = (await fs.readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(calls.some(call => call.args.includes('commands')));
    assert.ok(calls.some(call => call.args.includes('run') && call.args.includes('--sample')));
    assert.ok(!calls.some(call => call.args.includes('mcp')));
  } finally {
    delete process.env.CAUSYNE_ENGINE_DESIGN;
    await fs.rm(root, { recursive: true, force: true });
  }
});

const FAKE_WORD = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, 'word-engine.log'), JSON.stringify({ args }) + '\\n');
if (args.includes('--version')) {
  console.log('causyne-engine-word 0.6.1');
  process.exit(0);
}
const sub = args[0];
if (sub === 'commands') {
  console.log(JSON.stringify([{ id: 'text.insert', label: 'Insert Text' }, { id: 'para.format', label: 'Format Paragraph' }]));
} else if (sub === 'info') {
  console.log(JSON.stringify({ pages: 12, words: 3400, paragraphs: 85 }));
} else if (sub === 'run') {
  const saveIdx = args.indexOf('--save');
  if (saveIdx >= 0) {
    const savePath = args[saveIdx + 1];
    fs.mkdirSync(path.dirname(savePath), { recursive: true });
    fs.writeFileSync(savePath, 'word-doc-saved');
  }
  console.log(JSON.stringify({ ok: true }));
} else if (sub === 'convert') {
  const out = args[2];
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, 'converted-word');
  console.log(JSON.stringify({ ok: true, out }));
} else if (sub === 'render') {
  const out = args[2];
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, 'word-rendered-page');
  console.log(JSON.stringify({ ok: true, out }));
}
`;

test('native word engine drives catalog, describe, inspect, execute, export and render without MCP', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'causyne-word-test-'));
  const binary = path.join(root, 'causyne-engine-word');
  const log = path.join(root, 'word-engine.log');
  await fs.writeFile(binary, FAKE_WORD, { mode: 0o755 });
  process.env.CAUSYNE_ENGINE_WORD = binary;
  try {
    const context = { workspacePaths: [root] };
    const status = await nativeEngineTool.execute({ engine: 'word', action: 'status' }, context);
    const word = status.engines.find(e => e.id === 'word');
    assert.equal(word.installed, true);
    assert.equal(word.version, '0.6.1');

    const catalog = await nativeEngineTool.execute({ engine: 'word', action: 'catalog' }, context);
    assert.equal(catalog.success, true);
    assert.equal(catalog.data[0].id, 'text.insert');

    const executed = await nativeEngineTool.execute({
      engine: 'word',
      action: 'execute',
      command: 'text.insert',
      params: { text: 'Hello Causyne' },
      demo: true,
      saveAs: 'document.docx'
    }, context);
    assert.equal(executed.success, true);
    assert.ok(executed.artifacts.includes('document.docx'));
    assert.equal(await fs.readFile(path.join(root, 'document.docx'), 'utf8'), 'word-doc-saved');

    const probed = await nativeEngineTool.execute({
      engine: 'word',
      action: 'probe',
      query: 'document.docx'
    }, context);
    assert.equal(probed.success, true);
    assert.equal(probed.data.words, 3400);

    const exported = await nativeEngineTool.execute({
      engine: 'word',
      action: 'export',
      project: 'document.docx',
      output: 'document.pdf'
    }, context);
    assert.equal(exported.success, true);
    assert.deepEqual(exported.artifacts, ['document.pdf']);

    const rendered = await nativeEngineTool.execute({
      engine: 'word',
      action: 'render',
      project: 'document.docx',
      output: 'doc-page-1.png'
    }, context);
    assert.equal(rendered.success, true);
    assert.deepEqual(rendered.artifacts, ['doc-page-1.png']);
    assert.equal(await fs.readFile(path.join(root, 'doc-page-1.png'), 'utf8'), 'word-rendered-page');

    const calls = (await fs.readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(calls.some(call => call.args.includes('commands')));
    assert.ok(calls.some(call => call.args.includes('run') && call.args.includes('--template')));
    assert.ok(!calls.some(call => call.args.includes('mcp')));
  } finally {
    delete process.env.CAUSYNE_ENGINE_WORD;
    await fs.rm(root, { recursive: true, force: true });
  }
});

const FAKE_GRID = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, 'grid-engine.log'), JSON.stringify({ args }) + '\\n');
if (args.includes('version') || args.includes('--version')) {
  console.log('causyne-engine-grid 0.6.1');
  process.exit(0);
}
const sub = args[0];
if (sub === 'commands') {
  console.log(JSON.stringify([{ id: 'cell.set', label: 'Set Cell Value' }, { id: 'sheet.add', label: 'Add Sheet' }]));
} else if (sub === 'info') {
  console.log(JSON.stringify({ sheets: ['Sheet1'], cells: 150 }));
} else if (sub === 'run') {
  const outIdx = args.indexOf('--out');
  if (outIdx >= 0) {
    const outPath = args[outIdx + 1];
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, 'grid-saved-workbook');
  }
  console.log(JSON.stringify({ ok: true }));
} else if (sub === 'convert') {
  const out = args[2];
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, 'converted-grid');
  console.log(JSON.stringify({ ok: true, out }));
}
`;

test('native grid engine drives catalog, describe, inspect, execute, export and render without MCP', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'causyne-grid-test-'));
  const binary = path.join(root, 'causyne-engine-grid');
  const log = path.join(root, 'grid-engine.log');
  await fs.writeFile(binary, FAKE_GRID, { mode: 0o755 });
  process.env.CAUSYNE_ENGINE_GRID = binary;
  try {
    const context = { workspacePaths: [root] };
    const status = await nativeEngineTool.execute({ engine: 'grid', action: 'status' }, context);
    const grid = status.engines.find(e => e.id === 'grid');
    assert.equal(grid.installed, true);
    assert.equal(grid.version, '0.6.1');

    const catalog = await nativeEngineTool.execute({ engine: 'grid', action: 'catalog' }, context);
    assert.equal(catalog.success, true);
    assert.equal(catalog.data[0].id, 'cell.set');

    const executed = await nativeEngineTool.execute({
      engine: 'grid',
      action: 'execute',
      command: 'cell.set',
      params: { cell: 'A1', value: 100 },
      demo: true,
      saveAs: 'budget.xlsx'
    }, context);
    assert.equal(executed.success, true);
    assert.ok(executed.artifacts.includes('budget.xlsx'));
    assert.equal(await fs.readFile(path.join(root, 'budget.xlsx'), 'utf8'), 'grid-saved-workbook');

    const probed = await nativeEngineTool.execute({
      engine: 'grid',
      action: 'probe',
      query: 'budget.xlsx'
    }, context);
    assert.equal(probed.success, true);
    assert.deepEqual(probed.data.sheets, ['Sheet1']);

    const exported = await nativeEngineTool.execute({
      engine: 'grid',
      action: 'export',
      project: 'budget.xlsx',
      output: 'budget.csv'
    }, context);
    assert.equal(exported.success, true);
    assert.deepEqual(exported.artifacts, ['budget.csv']);

    const rendered = await nativeEngineTool.execute({
      engine: 'grid',
      action: 'render',
      project: 'budget.xlsx',
      output: 'rendered.html'
    }, context);
    assert.equal(rendered.success, true);
    assert.deepEqual(rendered.artifacts, ['rendered.html']);

    const calls = (await fs.readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(calls.some(call => call.args.includes('commands')));
    assert.ok(calls.some(call => call.args.includes('run') && call.args.includes('--sample')));
    assert.ok(!calls.some(call => call.args.includes('mcp')));
  } finally {
    delete process.env.CAUSYNE_ENGINE_GRID;
    await fs.rm(root, { recursive: true, force: true });
  }
});

const FAKE_LIGHT = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, 'light-engine.log'), JSON.stringify({ args }) + '\\n');
if (args.includes('--version')) {
  console.log('causyne-engine-light 0.7.1');
  process.exit(0);
}
const sub = args[0];
if (sub === 'controls') {
  console.log(JSON.stringify([{ id: 'exposure', label: 'Exposure', min: -5, max: 5 }]));
} else if (sub === 'run') {
  const libIdx = args.indexOf('--library');
  if (libIdx >= 0) {
    const libPath = args[libIdx + 1];
    fs.mkdirSync(path.dirname(libPath), { recursive: true });
    fs.writeFileSync(libPath, 'light-saved');
  }
  console.log(JSON.stringify({ ok: true }));
} else if (sub === 'render') {
  const oIdx = args.indexOf('-o');
  if (oIdx >= 0) {
    const outPath = args[oIdx + 1];
    if (outPath !== '/dev/null') {
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, 'light-rendered');
    }
  }
  console.log(JSON.stringify({ ok: true }));
}
`;

test('native light engine drives catalog, describe, inspect, execute, export and render without MCP', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'causyne-light-test-'));
  const binary = path.join(root, 'causyne-engine-light');
  const log = path.join(root, 'light-engine.log');
  await fs.writeFile(binary, FAKE_LIGHT, { mode: 0o755 });
  process.env.CAUSYNE_ENGINE_LIGHT = binary;
  try {
    const context = { workspacePaths: [root] };
    const status = await nativeEngineTool.execute({ engine: 'light', action: 'status' }, context);
    const light = status.engines.find(e => e.id === 'light');
    assert.equal(light.installed, true);
    assert.equal(light.version, '0.7.1');

    const catalog = await nativeEngineTool.execute({ engine: 'light', action: 'catalog' }, context);
    assert.equal(catalog.success, true);
    assert.equal(catalog.data[0].id, 'exposure');

    const executed = await nativeEngineTool.execute({
      engine: 'light',
      action: 'execute',
      command: 'develop.auto',
      demo: true,
      saveAs: 'catalog.lightlib'
    }, context);
    assert.equal(executed.success, true);
    assert.ok(executed.artifacts.includes('catalog.lightlib'));

    await fs.writeFile(path.join(root, 'photo.raw'), 'raw-image-bytes');

    const exported = await nativeEngineTool.execute({
      engine: 'light',
      action: 'export',
      project: 'photo.raw',
      output: 'photo.jpg'
    }, context);
    assert.equal(exported.success, true);
    assert.deepEqual(exported.artifacts, ['photo.jpg']);
    assert.equal(await fs.readFile(path.join(root, 'photo.jpg'), 'utf8'), 'light-rendered');

    const rendered = await nativeEngineTool.execute({
      engine: 'light',
      action: 'render',
      project: 'photo.raw',
      output: 'preview.png'
    }, context);
    assert.equal(rendered.success, true);
    assert.deepEqual(rendered.artifacts, ['preview.png']);

    const calls = (await fs.readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(calls.some(call => call.args.includes('controls')));
    assert.ok(calls.some(call => call.args.includes('run') && call.args.includes('--demo')));
    assert.ok(!calls.some(call => call.args.includes('mcp')));
  } finally {
    delete process.env.CAUSYNE_ENGINE_LIGHT;
    await fs.rm(root, { recursive: true, force: true });
  }
});

const FAKE_PDF = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, 'pdf-engine.log'), JSON.stringify({ args }) + '\\n');
if (args.includes('--help')) {
  console.log('causyne-engine-pdf 0.7.1\\nUsage: causyne-engine-pdf <info|render|text|edit|extract>');
  process.exit(0);
}
if (args.includes('--version')) {
  console.log('causyne-engine-pdf 0.7.1');
  process.exit(0);
}
const sub = args[0];
if (sub === 'tools') {
  console.log(JSON.stringify([{ id: 'doc_open', description: 'Open document' }]));
} else if (sub === 'info') {
  console.log(JSON.stringify({ pages: 5, version: '1.7', title: 'Doc' }));
} else if (sub === 'render') {
  const outIdx = args.indexOf('--out');
  if (outIdx >= 0) {
    const out = args[outIdx + 1];
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, 'pdf-rendered-page');
  }
  console.log(JSON.stringify({ ok: true }));
} else if (sub === 'extract') {
  const outIdx = args.indexOf('--out');
  if (outIdx >= 0) {
    const out = args[outIdx + 1];
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, 'pdf-extracted-doc');
  }
  console.log(JSON.stringify({ ok: true }));
} else if (sub === 'run') {
  const outIdx = args.indexOf('--out');
  if (outIdx >= 0) {
    const out = args[outIdx + 1];
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, 'pdf-step-result');
  }
  console.log(JSON.stringify({ ok: true }));
}
`;

test('native pdf engine drives catalog, describe, inspect, execute, export and render without MCP', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'causyne-pdf-test-'));
  const binary = path.join(root, 'causyne-engine-pdf');
  const log = path.join(root, 'pdf-engine.log');
  await fs.writeFile(binary, FAKE_PDF, { mode: 0o755 });
  process.env.CAUSYNE_ENGINE_PDF = binary;
  try {
    const context = { workspacePaths: [root] };
    const status = await nativeEngineTool.execute({ engine: 'pdf', action: 'status' }, context);
    const pdf = status.engines.find(e => e.id === 'pdf');
    assert.equal(pdf.installed, true);
    assert.equal(pdf.version, '0.7.1');

    const catalog = await nativeEngineTool.execute({ engine: 'pdf', action: 'catalog' }, context);
    assert.equal(catalog.success, true);
    assert.equal(catalog.data[0].id, 'doc_open');

    await fs.writeFile(path.join(root, 'sample.pdf'), '%PDF-1.7');

    const inspected = await nativeEngineTool.execute({
      engine: 'pdf',
      action: 'inspect',
      project: 'sample.pdf'
    }, context);
    assert.equal(inspected.success, true);
    assert.equal(inspected.data.pages, 5);

    const executed = await nativeEngineTool.execute({
      engine: 'pdf',
      action: 'execute',
      command: 'rotate_pages',
      params: { pages: [1], degrees: 90 },
      saveAs: 'rotated.pdf'
    }, context);
    assert.equal(executed.success, true);
    assert.ok(executed.artifacts.includes('rotated.pdf'));

    const rendered = await nativeEngineTool.execute({
      engine: 'pdf',
      action: 'render',
      project: 'sample.pdf',
      output: 'page1.png',
      start: 1,
      quality: 96
    }, context);
    assert.equal(rendered.success, true);
    assert.deepEqual(rendered.artifacts, ['page1.png']);
    assert.equal(await fs.readFile(path.join(root, 'page1.png'), 'utf8'), 'pdf-rendered-page');

    const exported = await nativeEngineTool.execute({
      engine: 'pdf',
      action: 'export',
      project: 'sample.pdf',
      output: 'extracted.pdf',
      params: { pages: '1,2' }
    }, context);
    assert.equal(exported.success, true);
    assert.deepEqual(exported.artifacts, ['extracted.pdf']);

    const calls = (await fs.readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(calls.some(call => call.args.includes('tools')));
    assert.ok(calls.some(call => call.args.includes('info')));
    assert.ok(!calls.some(call => call.args.includes('mcp')));
  } finally {
    delete process.env.CAUSYNE_ENGINE_PDF;
    await fs.rm(root, { recursive: true, force: true });
  }
});

const FAKE_EFFECT = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
fs.appendFileSync(path.join(__dirname, 'effect-engine.log'), JSON.stringify({ args }) + '\\n');
if (args.includes('--version')) {
  console.log('causyne-engine-effect 0.9.2');
  process.exit(0);
}
if (args[0] === 'info') {
  console.log(JSON.stringify({ ok: true, version: '0.9.2', comp: 'Main' }));
  process.exit(0);
}
const sub = args[0];
if (sub === 'commands') {
  console.log(JSON.stringify([{ id: 'layer.add', description: 'Add layer' }]));
} else if (sub === 'run') {
  const saveIdx = args.indexOf('--save-as');
  if (saveIdx >= 0) {
    const savePath = args[saveIdx + 1];
    fs.mkdirSync(path.dirname(savePath), { recursive: true });
    fs.writeFileSync(savePath, 'effect-project-data');
  }
  console.log(JSON.stringify({ ok: true }));
} else if (sub === 'render-frame') {
  const outIdx = args.indexOf('--out');
  if (outIdx >= 0) {
    const out = args[outIdx + 1];
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, 'effect-frame-bytes');
  }
  console.log(JSON.stringify({ ok: true }));
} else if (sub === 'render') {
  const outIdx = args.indexOf('--out');
  if (outIdx >= 0) {
    const out = args[outIdx + 1];
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, 'effect-video-bytes');
  }
  console.log(JSON.stringify({ ok: true }));
}
`;

test('native effect engine drives catalog, describe, inspect, execute, export and render without MCP', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'causyne-effect-test-'));
  const binary = path.join(root, 'causyne-engine-effect');
  const log = path.join(root, 'effect-engine.log');
  await fs.writeFile(binary, FAKE_EFFECT, { mode: 0o755 });
  process.env.CAUSYNE_ENGINE_EFFECT = binary;
  try {
    const context = { workspacePaths: [root] };
    const status = await nativeEngineTool.execute({ engine: 'effect', action: 'status' }, context);
    const effect = status.engines.find(e => e.id === 'effect');
    assert.equal(effect.installed, true);
    assert.equal(effect.version, '0.9.2');

    const catalog = await nativeEngineTool.execute({ engine: 'effect', action: 'catalog' }, context);
    assert.equal(catalog.success, true);
    assert.equal(catalog.data[0].id, 'layer.add');

    const executed = await nativeEngineTool.execute({
      engine: 'effect',
      action: 'execute',
      command: 'layer.add',
      params: { type: 'solid', color: '#ff0000' },
      demo: true,
      saveAs: 'comp.ecproj'
    }, context);
    assert.equal(executed.success, true);
    assert.ok(executed.artifacts.includes('comp.ecproj'));

    const rendered = await nativeEngineTool.execute({
      engine: 'effect',
      action: 'render',
      project: 'comp.ecproj',
      output: 'frame.png',
      seconds: 2.0
    }, context);
    assert.equal(rendered.success, true);
    assert.deepEqual(rendered.artifacts, ['frame.png']);
    assert.equal(await fs.readFile(path.join(root, 'frame.png'), 'utf8'), 'effect-frame-bytes');

    const exported = await nativeEngineTool.execute({
      engine: 'effect',
      action: 'export',
      project: 'comp.ecproj',
      output: 'export.mp4',
      quality: 30
    }, context);
    assert.equal(exported.success, true);
    assert.deepEqual(exported.artifacts, ['export.mp4']);
    assert.equal(await fs.readFile(path.join(root, 'export.mp4'), 'utf8'), 'effect-video-bytes');

    const calls = (await fs.readFile(log, 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(calls.some(call => call.args.includes('commands')));
    assert.ok(calls.some(call => call.args.includes('render-frame')));
    assert.ok(!calls.some(call => call.args.includes('mcp')));
  } finally {
    delete process.env.CAUSYNE_ENGINE_EFFECT;
    await fs.rm(root, { recursive: true, force: true });
  }
});
