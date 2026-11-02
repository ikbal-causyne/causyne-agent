import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  rememberSelectionMask,
  getLatestSelectionMask,
  clearSelectionMaskCache,
  validateAdobeLiveJob,
  buildAdobeLiveExtendScript,
  runAdobeLiveBridge,
  validateGameEngineJob,
  buildUnrealPythonScript,
  buildUnityEditorScript,
  buildGodotImportScript,
  runGameEngineBridge,
  scaffoldCausyneUxpPlugin,
  buildAdobeHostInvocationPlan,
  verifyAllCreativeAndGameBridges
} from '../src/creative/liveBridge.js';
import { creativeAppStatus } from '../src/creative/apps.js';
import { runStudioPipeline } from '../src/creative/pipeline.js';
import { creativeApps } from '../src/tools/creativeApps.js';
import { resolveAutomator, buildResolvePlatformConfig } from '../src/tools/resolveAutomator.js';
import { resolveChannel } from '../src/appChannel.js';
import { decideTools } from '../src/decideTools.js';

test('creativeAppStatus discovers all 6 Adobe hosts, DaVinci Resolve, Blender, and 3 Game Engines (Unreal, Unity, Godot)', async () => {
  const apps = await creativeAppStatus();
  const ids = apps.map(a => a.id);
  for (const expected of [
    'blender',
    'photoshop',
    'premiere',
    'after-effects',
    'illustrator',
    'indesign',
    'media-encoder',
    'resolve',
    'unreal',
    'unity',
    'godot'
  ]) {
    assert.ok(ids.includes(expected), `Missing host "${expected}" in creativeAppStatus()`);
  }
});

test('SelectionMaskCache stores, retrieves, and bounds LRU entries to 128 documents', () => {
  clearSelectionMaskCache();
  for (let i = 0; i < 135; i++) {
    rememberSelectionMask(`doc_${i}.psd`, {
      left: 10.2,
      top: 20.8,
      right: 310.4,
      bottom: 220.6,
      width: 300,
      height: 200
    });
  }
  assert.equal(getLatestSelectionMask('doc_0.psd'), null, 'Oldest entry beyond 128 should be evicted');
  const latest = getLatestSelectionMask('doc_134.psd');
  assert.ok(latest);
  assert.equal(latest.bounds.left, 10);
  assert.equal(latest.bounds.top, 21);
  assert.equal(latest.bounds.width, 300);
  assert.equal(latest.bounds.height, 200);
  clearSelectionMaskCache();
});

test('Adobe live bridge generates valid ExtendScript for Photoshop canvas preview and selection-masked placement', () => {
  const previewJob = validateAdobeLiveJob({
    host: 'photoshop',
    liveOperation: 'export_canvas_preview',
    output: 'preview.png',
    maxDimension: 2048,
    layerOnly: true
  });
  assert.equal(previewJob.maxDimension, 1024, 'maxDimension must clamp to 1024');
  assert.equal(previewJob.layerOnly, true);

  const previewJsx = buildAdobeLiveExtendScript(previewJob, '/tmp/receipt.json');
  assert.ok(previewJsx.includes('dup.trim(TrimType.TRANSPARENT'));
  assert.ok(previewJsx.includes('PNGSaveOptions'));
  assert.ok(previewJsx.includes('selectionBounds'));

  const placeJob = validateAdobeLiveJob({
    host: 'photo-studio',
    liveOperation: 'place_in_active_canvas',
    input: 'render.png',
    fitMode: 'selection',
    applySelectionMask: true,
    layerName: 'Hero Key Art'
  });
  assert.equal(placeJob.canonicalHost, 'photoshop');
  const placeJsx = buildAdobeLiveExtendScript(placeJob, '/tmp/receipt.json', {
    left: 50,
    top: 60,
    right: 450,
    bottom: 360,
    width: 400,
    height: 300
  });
  assert.ok(placeJsx.includes('charIDToTypeID("Plc ")'));
  assert.ok(placeJsx.includes('Hero Key Art'));
  assert.ok(placeJsx.includes('charIDToTypeID("Mk  ")'));
  assert.ok(placeJsx.includes('charIDToTypeID("RvlS")'));
});

test('Adobe live bridge generates valid ExtendScript for Premiere Pro and After Effects active timeline insertion', () => {
  const premiereJob = validateAdobeLiveJob({
    host: 'premiere',
    liveOperation: 'insert_in_active_timeline',
    input: 'shot_01.mp4',
    atPlayhead: true,
    track: 1
  });
  const premiereJsx = buildAdobeLiveExtendScript(premiereJob, '/tmp/pr_receipt.json');
  assert.ok(premiereJsx.includes('app.project.activeSequence'));
  assert.ok(premiereJsx.includes('seq.getPlayerPosition()'));
  assert.ok(premiereJsx.includes('targetTrack.insertClip'));

  const aeJob = validateAdobeLiveJob({
    host: 'after-effects',
    liveOperation: 'insert_in_active_timeline',
    input: 'vfx_overlay.mov',
    atPlayhead: false,
    start: 4.5
  });
  const aeJsx = buildAdobeLiveExtendScript(aeJob, '/tmp/ae_receipt.json');
  assert.ok(aeJsx.includes('comp instanceof CompItem'));
  assert.ok(aeJsx.includes('comp.layers.add(footage)'));
  assert.ok(aeJsx.includes('layer.startTime = 4.5'));
});

test('Game Engine bridge stages Unreal Python, Unity C# Editor, and Godot GDScript automation inside workspace', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'causyne-game-bridge-'));
  try {
    const texFile = path.join(root, 'albedo.png');
    await fs.writeFile(texFile, 'fake-png-bytes', 'utf8');

    // 1. Unreal Engine 5 import_assets + spawn_actor
    const unrealRes = await runGameEngineBridge(
      {
        engine: 'unreal',
        engineOperation: 'import_assets',
        projectPath: 'UnrealProject',
        assets: ['albedo.png'],
        destinationFolder: '/Game/Characters/Hero',
        executeHeadless: false
      },
      root
    );
    assert.equal(unrealRes.success, true);
    assert.equal(unrealRes.mode, 'staged_python_bridge');
    const pyContent = await fs.readFile(String(unrealRes.scriptPath), 'utf8');
    assert.ok(pyContent.includes('unreal.AssetImportTask()'));
    assert.ok(pyContent.includes('/Game/Characters/Hero'));

    // 2. Unity Editor import_assets + spawn_actor
    const unityRes = await runGameEngineBridge(
      {
        engine: 'unity',
        engineOperation: 'spawn_actor',
        projectPath: 'UnityProject',
        assets: ['albedo.png'],
        destinationFolder: 'Assets/CausyneHero',
        actorName: 'HeroRig',
        location: [10, 0, -5],
        executeHeadless: false
      },
      root
    );
    assert.equal(unityRes.success, true);
    assert.equal(unityRes.mode, 'staged_editor_bridge');
    const csContent = await fs.readFile(String(unityRes.editorScriptPath), 'utf8');
    assert.ok(csContent.includes('public static class CausyneUnityBridge'));
    assert.ok(csContent.includes('AssetDatabase.ImportAsset'));
    assert.ok(csContent.includes('HeroRig'));
    assert.ok(csContent.includes('new Vector3(10f, 0f, -5f)'));

    // 3. Godot 4 import_assets + spawn_actor
    const godotRes = await runGameEngineBridge(
      {
        engine: 'godot',
        engineOperation: 'spawn_actor',
        projectPath: 'GodotProject',
        assets: ['albedo.png'],
        actorName: 'GodotHeroNode',
        executeHeadless: false
      },
      root
    );
    assert.equal(godotRes.success, true);
    assert.equal(godotRes.mode, 'staged_gdscript_bridge');
    const gdContent = await fs.readFile(String(godotRes.scriptPath), 'utf8');
    assert.ok(gdContent.includes('extends SceneTree'));
    assert.ok(gdContent.includes('GodotHeroNode'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('UXP companion plugin scaffolder creates Manifest v5 plugin for Photoshop and Premiere Pro', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'causyne-uxp-test-'));
  try {
    const res = await scaffoldCausyneUxpPlugin('uxp-plugin', root, { websocketPort: 8090 });
    assert.equal(res.success, true);
    const manifestRaw = await fs.readFile(path.join(root, 'uxp-plugin', 'manifest.json'), 'utf8');
    const manifest = JSON.parse(manifestRaw);
    assert.equal(manifest.manifestVersion, 5);
    assert.equal(manifest.id, 'com.causyne.studio.bridge');
    assert.deepEqual(
      manifest.host.map((h: { app: string }) => h.app),
      ['PS', 'PPRO']
    );
    const bridgeCode = await fs.readFile(path.join(root, 'uxp-plugin', 'bridge.js'), 'utf8');
    assert.ok(bridgeCode.includes('exportActivePhotoshopCanvasPreview'));
    assert.ok(bridgeCode.includes('placeImageOnCanvas'));
    assert.ok(!/higgsfield/i.test(manifestRaw + bridgeCode), 'Must contain zero competitor naming');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('studio_pipeline chains live_bridge and engine_bridge stages seamlessly', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'causyne-pipeline-bridge-'));
  try {
    const assetFile = path.join(root, 'concept_art.png');
    await fs.writeFile(assetFile, 'png-bytes', 'utf8');

    const result = await runStudioPipeline(
      {
        stages: [
          {
            id: 'stage_ps_place',
            type: 'live_bridge',
            config: {
              host: 'photoshop',
              liveOperation: 'place_in_active_canvas',
              input: 'concept_art.png',
              fitMode: 'selection',
              stageOnly: true
            }
          },
          {
            id: 'stage_unreal_import',
            type: 'engine_bridge',
            config: {
              engine: 'unreal',
              engineOperation: 'import_assets',
              projectPath: 'UE5Game',
              assets: ['concept_art.png'],
              executeHeadless: false
            }
          }
        ]
      },
      root
    );

    assert.equal(result.success, true);
    assert.equal(result.stagesCompleted, 2);
    assert.equal(result.stageResults.length, 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('Channel A router and decideTools route Adobe Suite, Unreal Engine, and Unity directly to creative_apps', () => {
  for (const appName of [
    'Adobe Photoshop',
    'Premiere Pro',
    'After Effects',
    'Adobe Illustrator',
    'Adobe InDesign',
    'Adobe Media Encoder',
    'Unreal Engine',
    'Unity Editor'
  ]) {
    const ch = resolveChannel(appName);
    assert.equal(ch.channel, 'A', `${appName} must route to Channel A`);
    assert.equal(ch.tool, 'creative_apps', `${appName} must route to creative_apps`);
    assert.equal(ch.blocked, true);
  }

  const decision = decideTools({
    source: 'intent',
    list: [],
    prompt: 'Export the active Photoshop selection preview and import the generated texture into Unreal Engine 5 and Premiere Pro'
  });
  assert.ok(decision.packs.includes('media') || decision.packs.includes('game'));
});

test('cross-platform planner builds valid macOS (darwin), Windows (win32), and Linux invocations for Adobe and DaVinci Resolve', () => {
  for (const host of ['photoshop', 'premiere', 'after-effects', 'illustrator', 'indesign', 'media-encoder'] as const) {
    const macPlan = buildAdobeHostInvocationPlan('darwin', host, '/tmp/bridge.jsx');
    assert.ok(macPlan, `macOS invocation plan missing for ${host}`);
    assert.equal(macPlan.command, 'osascript');
    if (host === 'after-effects') {
      assert.ok(macPlan.args[1]?.includes('DoScriptFile'));
    } else {
      assert.ok(macPlan.args[1]?.includes('do javascript file POSIX file'));
    }

    const winPlan = buildAdobeHostInvocationPlan('win32', host, 'C:\\temp\\bridge.jsx');
    assert.ok(winPlan, `Windows invocation plan missing for ${host}`);
    assert.ok(winPlan.command.startsWith('C:\\Program Files\\Adobe\\'));
    assert.deepEqual(winPlan.args, ['-r', 'C:\\temp\\bridge.jsx']);
  }

  const macResolve = buildResolvePlatformConfig('darwin', {});
  assert.ok(macResolve.scriptLib.endsWith('fusionscript.so'));
  assert.equal(macResolve.pathSep, ':');

  const winResolve = buildResolvePlatformConfig('win32', {});
  assert.ok(winResolve.scriptLib.endsWith('fusionscript.dll'));
  assert.equal(winResolve.pathSep, ';');

  const linuxResolve = buildResolvePlatformConfig('linux', {});
  assert.ok(linuxResolve.scriptLib.endsWith('/opt/resolve/libs/Fusion/fusionscript.so'));
  assert.equal(linuxResolve.pathSep, ':');
});

test('DaVinci Resolve bridge executes all 8 cinema workflows end-to-end in Python simulator without Resolve installed', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'causyne-resolve-test-'));
  try {
    const clipFile = path.join(root, 'cinema_shot.mov');
    await fs.writeFile(clipFile, 'fake-mov-data', 'utf8');

    const conn = await resolveAutomator.execute({ action: 'checkConnection', simulate: true });
    assert.equal(conn.success, true);

    const inspect = await resolveAutomator.execute({ action: 'inspectActive', simulate: true });
    assert.equal(inspect.success, true);
    assert.equal(inspect.projectName, 'Causyne_Cinema_Project');

    const rcmAuto = await resolveAutomator.execute({
      action: 'setupColorManagement',
      color_space_mode: 'automatic',
      simulate: true
    });
    assert.equal(rcmAuto.success, true);

    const rcmCustom = await resolveAutomator.execute({
      action: 'setupColorManagement',
      color_space_mode: 'custom',
      input_color_space: 'ARRI LogC3',
      output_color_space: 'Rec.709 Gamma 2.4',
      simulate: true
    });
    assert.equal(rcmCustom.success, true);

    const assemble = await resolveAutomator.execute({
      action: 'importAndAssemble',
      mediaPath: clipFile,
      markerName: 'VFX Cut',
      simulate: true
    });
    assert.equal(assemble.success, true);

    const marker = await resolveAutomator.execute({
      action: 'addMarker',
      frameId: 48,
      markerColor: 'Red',
      markerName: 'Color Note',
      simulate: true
    });
    assert.equal(marker.success, true);

    const grade = await resolveAutomator.execute({
      action: 'applyLutOrGrade',
      lutPath: '/luts/Kodak2383.cube',
      cdl: { slope: '1.02 1.0 0.96', offset: '0 0 0', power: '1 1 1', saturation: '1.05' },
      simulate: true
    });
    assert.equal(grade.success, true);

    const render = await resolveAutomator.execute({
      action: 'renderTimeline',
      presetName: 'H.264 Master',
      targetDir: root,
      customName: 'Master_Out',
      simulate: true
    });
    assert.equal(render.success, true);
    assert.equal(render.jobId, 'resolve_render_job_001');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('verify_bridge runs full end-to-end simulation across Adobe DOM, DaVinci Resolve, Unreal Engine 5, Unity, and Godot without host installations', async () => {
  const report = await verifyAllCreativeAndGameBridges(process.cwd());
  assert.equal(report.success, true, `verifyAllCreativeAndGameBridges failed: ${JSON.stringify(report)}`);
});
