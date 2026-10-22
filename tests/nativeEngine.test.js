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
