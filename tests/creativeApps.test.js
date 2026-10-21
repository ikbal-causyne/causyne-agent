import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseBatch, runBlenderBatch } from '../src/creative/blenderBatch.js';
import { creativeApps } from '../src/tools/creativeApps.js';
import { resolveTool } from '../src/tools/registry.js';

test('creative tool is discoverable through the native registry', () => {
  assert.equal(resolveTool('creative_apps'), creativeApps);
});
test('batch contract rejects arbitrary code, malformed transforms and excessive jobs', () => {
  for (const actions of [
    [{type:'executePython',name:'x',code:'print(1)'}],
    [{type:'transform',name:'x',location:[1,NaN,3]}],
    [{type:'transform',name:'x'}],
    Array.from({length:65},()=>({type:'add_cube',name:'x'}))
  ]) assert.throws(()=>parseBatch({output:'new.blend',actions}));
  assert.deepEqual(parseBatch({output:'new.blend',actions:[{type:'add_cube',name:'Cube'}]}).actions[0].scale,[1,1,1]);
});
test('tool returns failure on unsupported operations', async () => {
  assert.equal((await creativeApps.execute({action:'unknown_action'})).success,false);
  assert.equal((await creativeApps.execute({action:'blender_batch',output:'x.blend',actions:[{type:'eval',name:'x'}]})).success,false);
});
test('batch blocks overwrites, traversal and symlink escape before launching Blender', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'causyne-batch-test-'));
  const outside=await fs.mkdtemp(path.join(os.tmpdir(),'causyne-outside-test-'));
  try {
    await fs.writeFile(path.join(root,'existing.blend'),'original');
    await assert.rejects(runBlenderBatch({output:'existing.blend',actions:[]},root),/already exists/);
    await assert.rejects(runBlenderBatch({output:path.join(outside,'escape.blend'),actions:[]},root),/workspace/);
    await fs.symlink(outside,path.join(root,'link'),process.platform==='win32'?'junction':'dir');
    await assert.rejects(runBlenderBatch({output:'link/escape.blend',actions:[]},root),/workspace/);
    assert.equal(await fs.readFile(path.join(root,'existing.blend'),'utf8'),'original');
  } finally { await fs.rm(root,{recursive:true,force:true}); await fs.rm(outside,{recursive:true,force:true}); }
});

test('real Blender batch persists state and reports native failures', {skip:process.env.CAUSYNE_TEST_BLENDER!=='1'}, async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'causyne-native-batch-'));
  try {
    await runBlenderBatch({output:'first.blend',actions:[{type:'add_cube',name:'VerifiedCube'},{type:'transform',name:'VerifiedCube',location:[1,2,3]}]},root);
    const reopened=await runBlenderBatch({input:'first.blend',output:'second.blend',actions:[]},root);
    assert.deepEqual(reopened.summary.objects.find(o=>o.name==='VerifiedCube').location,[1,2,3]);
    await assert.rejects(runBlenderBatch({output:'failed.blend',actions:[{type:'transform',name:'missing',location:[1,2,3]}]},root));
    await assert.rejects(fs.stat(path.join(root,'failed.blend')), {code:'ENOENT'});
  } finally { await fs.rm(root,{recursive:true,force:true}); }
});

test('creative mutations use the approval policy while inventory is read-only', async () => {
  const { Sandbox } = await import('../src/sandbox.js');
  const sandbox = new Sandbox();
  assert.equal(sandbox.validate('creative_apps', {action:'status'}).risk,'safe');
  assert.equal(sandbox.validate('creative_apps', {action:'blender_batch'}).risk,'dangerous');
});
test('an already cancelled job never starts an app or writes files', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runBlenderBatch({output:'cancelled.blend',actions:[]},process.cwd(),controller.signal), {name:'AbortError'});
});

test('creative batches respect implementation plan gates', async () => {
  const { isMutatingToolCall } = await import('../src/decisionPolicy.js');
  assert.equal(isMutatingToolCall('creative_apps', {action:'status'}), false);
  assert.equal(isMutatingToolCall('creative_apps', {action:'blender_batch'}), true);
});

test('video studio script generator creates valid extendscript and enforces prproj format', async () => {
  const { validateStudioJob, studioScript } = await import('../src/creative/studioScripts.js');
  const validJob = {
    host: 'video-studio',
    output: 'test_edit.prproj',
    actions: [
      { type: 'sequence', name: 'MasterTimeline' },
      { type: 'import', path: 'video.mp4', start: 0, duration: 10 },
      { type: 'marker', start: 5, name: 'Highlight', comment: 'Action cut point' }
    ]
  };
  const validated = validateStudioJob(validJob);
  assert.equal(validated.canonicalHost, 'premiere');
  assert.equal(validated.output, 'test_edit.prproj');
  assert.equal(validated.actions.length, 3);

  const script = studioScript(validJob, '/tmp/receipt.txt');
  assert.ok(script.includes('createNewSequence'));
  assert.ok(script.includes('MasterTimeline'));
  assert.ok(script.includes('importFiles'));
  assert.ok(script.includes('CAUSYNE_EDIT_COMPLETE'));

  // Rejects invalid output extension
  assert.throws(() => validateStudioJob({
    host: 'video-studio',
    output: 'test.mp4',
    actions: [{ type: 'sequence', name: 'Seq' }]
  }), /PRPROJ or XML/);
});

test('expanded Blender actions accept primitives, lights, materials, and render configs', () => {
  const batch = parseBatch({
    output: 'scene.blend',
    actions: [
      { type: 'add_cube', name: 'Cube' },
      { type: 'add_sphere', name: 'Sphere', radius: 2.5 },
      { type: 'add_cylinder', name: 'Cylinder', radius: 1.0, depth: 4.0 },
      { type: 'add_plane', name: 'Ground' },
      { type: 'add_camera', name: 'MainCam', location: [0, -8, 4] },
      { type: 'add_light', name: 'KeyLight', lightType: 'SUN', energy: 1000 },
      { type: 'material', name: 'Sphere', color: [0.8, 0.2, 0.2, 1.0] },
      { type: 'render', name: 'OutputRender', outputPath: 'frame.png', resolution: [1920, 1080] }
    ]
  });
  assert.equal(batch.actions.length, 8);
  assert.equal(batch.actions[1].type, 'add_sphere');
  assert.equal(batch.actions[2].type, 'add_cylinder');
  assert.equal(batch.actions[5].type, 'add_light');
  assert.equal(batch.actions[6].type, 'material');
  assert.equal(batch.actions[7].type, 'render');
});

test('creativeAppStatus lists all four creative application hosts', async () => {
  const { creativeAppStatus } = await import('../src/creative/apps.js');
  const apps = await creativeAppStatus();
  const ids = apps.map(a => a.id);
  assert.ok(ids.includes('blender'));
  assert.ok(ids.includes('photoshop'));
  assert.ok(ids.includes('premiere'));
  assert.ok(ids.includes('after-effects'));
});

test('Blender batch supports PBR material roughness and metallic settings', () => {
  const batch = parseBatch({
    output: 'pbr_test.blend',
    actions: [
      { type: 'add_sphere', name: 'MetalBall' },
      { type: 'material', name: 'MetalBall', color: [0.9, 0.9, 0.9, 1.0], roughness: 0.1, metallic: 0.95 }
    ]
  });
  assert.equal(batch.actions.length, 2);
  const mat = batch.actions[1];
  assert.equal(mat.type, 'material');
  assert.equal(mat.roughness, 0.1);
  assert.equal(mat.metallic, 0.95);
});

test('photo studio script generator creates valid extendscript with typography and color adjustments', async () => {
  const { validateStudioJob, studioScript } = await import('../src/creative/studioScripts.js');
  const job = {
    host: 'photo-studio',
    output: 'promo.png',
    actions: [
      { type: 'resize', width: 1920, height: 1080 },
      { type: 'new_layer', name: 'Branding', opacity: 90 },
      { type: 'text', text: 'Causyne Agent Creative Suite', x: 100, y: 200, size: 48, font: 'Inter' },
      { type: 'adjust_color', brightness: 15, contrast: 10 },
      { type: 'flatten' }
    ]
  };
  const validated = validateStudioJob(job);
  assert.equal(validated.canonicalHost, 'photoshop');
  assert.equal(validated.actions.length, 5);

  const script = studioScript(job, '/tmp/test_receipt.txt');
  assert.ok(script.includes('resizeImage'));
  assert.ok(script.includes('artLayers.add()'));
  assert.ok(script.includes('adjustBrightnessContrast'));
  assert.ok(script.includes('"brightness":15'));
  assert.ok(script.includes('"contrast":10'));
  assert.ok(script.includes('flatten()'));
  assert.ok(script.includes('PNGSaveOptions'));
});

test('channel router directs creative studio hosts directly to creative_apps tool', async () => {
  const { resolveChannel } = await import('../src/appChannel.js');
  for (const name of ['photo-studio', 'video-studio', 'motion-studio', 'photostudio', 'videostudio', 'motionstudio']) {
    const choice = resolveChannel(name);
    assert.equal(choice.channel, 'A');
    assert.equal(choice.tool, 'creative_apps');
    assert.equal(choice.blocked, true);
  }
});

test('studio pipeline validation enforces stage types and configs', async () => {
  const { validatePipeline } = await import('../src/creative/pipeline.js');
  const validPipeline = {
    stages: [
      { id: 'render_3d', type: '3d_batch', config: { output: 'model.blend', actions: [{ type: 'add_cube', name: 'Box' }] } },
      { id: 'edit_banner', type: 'studio_batch', config: { host: 'photo-studio', output: 'banner.png', actions: [{ type: 'resize', width: 800, height: 600 }] } }
    ]
  };
  const validated = validatePipeline(validPipeline);
  assert.equal(validated.stages.length, 2);
  assert.equal(validated.stages[0].id, 'render_3d');
  assert.equal(validated.stages[1].type, 'studio_batch');

  // Rejects empty stages or invalid stage type
  assert.throws(() => validatePipeline({ stages: [] }));
  assert.throws(() => validatePipeline({ stages: [{ id: 'x', type: 'invalid_type', config: {} }] }));
});



