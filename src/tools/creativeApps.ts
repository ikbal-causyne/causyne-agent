import { runStudioEdit } from '../creative/studioScripts.js';
import { creativeAppStatus } from '../creative/apps.js';
import { runBlenderBatch } from '../creative/blenderBatch.js';
import { runStudioPipeline } from '../creative/pipeline.js';
import {
  runAdobeLiveBridge,
  runGameEngineBridge,
  scaffoldCausyneUxpPlugin,
  verifyAllCreativeAndGameBridges
} from '../creative/liveBridge.js';

export const creativeApps = {
  schema: {
    name: 'creative_apps',
    description:
      'Universal native machine-API bridge for Adobe Creative Suite ' +
      '(Photoshop, Premiere Pro, After Effects, Illustrator, InDesign, Media Encoder), ' +
      'Cinema Studio (DaVinci Resolve), 3D Studio (Blender), and Game Engines ' +
      '(Unreal Engine 5, Unity, Godot) with zero MCP token bloat. Supports: ' +
      '(1) status: inspect installed hosts; ' +
      '(2) live_bridge: interactive active-session Adobe & DaVinci Resolve operations ' +
      '(inspect_active, export_canvas_preview bounded 64..1024px PNG + selection bounds, ' +
      'place_in_active_canvas with selection/mask fitting, insert_in_active_timeline at playhead); ' +
      '(3) engine_bridge: direct Unreal Remote Control HTTP API (port 30010), ' +
      'Unreal Python asset/actor automation, Unity C# Editor batchmode/AssetDatabase import, ' +
      'and Godot headless bridge; ' +
      '(4) scaffold_uxp: generate native Adobe UXP v5 companion plugin; ' +
      '(5) verify_bridge: run full cross-platform (macOS/Windows/Linux) & DOM/Python ' +
      'simulator self-test without requiring host apps to be installed; ' +
      '(6) blender_batch, studio_edit, and studio_pipeline.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'status',
            'blender_batch',
            'studio_edit',
            'studio_pipeline',
            'live_bridge',
            'engine_bridge',
            'scaffold_uxp',
            'verify_bridge'
          ]
        },
        host: {
          type: 'string',
          enum: [
            'photoshop',
            'premiere',
            'after-effects',
            'illustrator',
            'indesign',
            'media-encoder',
            'resolve',
            'davinci-resolve',
            'photo-studio',
            'video-studio',
            'motion-studio',
            'vector-studio',
            'layout-studio',
            'encoder-studio',
            'cinema-studio'
          ]
        },
        liveOperation: {
          type: 'string',
          enum: [
            'inspect_active',
            'export_canvas_preview',
            'place_in_active_canvas',
            'insert_in_active_timeline'
          ],
          description: 'Interactive live operation for action="live_bridge" against the currently open Adobe document or sequence.'
        },
        fitMode: {
          type: 'string',
          enum: ['selection', 'bounds', 'document_height', 'original'],
          description: 'How place_in_active_canvas fits the placed asset onto the active canvas.'
        },
        bounds: {
          type: 'object',
          description: 'Target placement rectangle { left, top, width, height } in pixels for fitMode="bounds".',
          properties: {
            left: { type: 'number' },
            top: { type: 'number' },
            width: { type: 'number' },
            height: { type: 'number' }
          }
        },
        maxDimension: {
          type: 'integer',
          description: 'Maximum pixel dimension (64..1024) for export_canvas_preview.'
        },
        layerOnly: {
          type: 'boolean',
          description: 'When true in export_canvas_preview, trims preview to the active layer bounds.'
        },
        applySelectionMask: {
          type: 'boolean',
          description: 'When true in place_in_active_canvas, applies the active selection as a non-destructive reveal layer mask.'
        },
        layerName: {
          type: 'string',
          description: 'Name for the placed layer in place_in_active_canvas.'
        },
        atPlayhead: {
          type: 'boolean',
          description: 'When true in insert_in_active_timeline, inserts clip at current playhead position.'
        },
        start: {
          type: 'number',
          description: 'Timeline start time in seconds.'
        },
        track: {
          type: 'integer',
          description: 'Zero-based video/audio track index for timeline insertion.'
        },
        audioTrack: {
          type: 'boolean',
          description: 'When true, inserts clip into audioTracks instead of videoTracks.'
        },
        stageOnly: {
          type: 'boolean',
          description: 'When true in live_bridge, writes the generated ExtendScript (.jsx) into the workspace without invoking osascript/COM.'
        },
        simulateHost: {
          type: 'boolean',
          description: 'When true, executes the generated ExtendScript/Python bridge against the built-in Adobe DOM / DaVinci Resolve simulator for verification without host installation.'
        },
        engine: {
          type: 'string',
          enum: ['unreal', 'unreal-engine', 'unity', 'unity-editor', 'godot'],
          description: 'Target game engine for action="engine_bridge".'
        },
        engineOperation: {
          type: 'string',
          enum: ['remote_control', 'import_assets', 'spawn_actor'],
          description: 'Operation for action="engine_bridge".'
        },
        projectPath: {
          type: 'string',
          description: 'Workspace path to the Unreal, Unity, or Godot project directory.'
        },
        assets: {
          type: 'array',
          items: { type: 'string' },
          description: 'Workspace asset file paths (textures, FBX/GLB meshes, audio) to import into the game engine.'
        },
        destinationFolder: {
          type: 'string',
          description: 'Target content folder inside the engine (e.g. "/Game/CausyneAssets" or "Assets/CausyneAssets").'
        },
        objectPath: {
          type: 'string',
          description: 'Unreal UObject path for remote_control HTTP bridge.'
        },
        functionName: {
          type: 'string',
          description: 'Unreal UFunction name for remote_control HTTP call.'
        },
        propertyName: {
          type: 'string',
          description: 'Unreal UProperty name for remote_control property read/write.'
        },
        propertyValue: {
          description: 'Value to write for Unreal remote_control property access.'
        },
        parameters: {
          type: 'object',
          description: 'Function parameters payload for Unreal remote_control call.'
        },
        remotePort: {
          type: 'integer',
          description: 'Local loopback port for Unreal Remote Control HTTP API (default 30010).'
        },
        actorName: {
          type: 'string',
          description: 'Label/name for spawned actor, prefab instance, or scene node.'
        },
        actorClass: {
          type: 'string',
          description: 'Unreal actor class (e.g. StaticMeshActor, PointLight, CineCameraActor).'
        },
        assetPath: {
          type: 'string',
          description: 'Engine content path to mesh/prefab for spawn_actor.'
        },
        location: {
          type: 'array',
          items: { type: 'number' },
          minItems: 3,
          maxItems: 3
        },
        rotation: {
          type: 'array',
          items: { type: 'number' },
          minItems: 3,
          maxItems: 3
        },
        scale: {
          type: 'array',
          items: { type: 'number' },
          minItems: 3,
          maxItems: 3
        },
        executeHeadless: {
          type: 'boolean',
          description: 'Whether to execute the local Unreal/Unity/Godot CLI binary immediately if installed (default true).'
        },
        outputDir: {
          type: 'string',
          description: 'Workspace output directory for action="scaffold_uxp".'
        },
        websocketPort: {
          type: 'integer',
          description: 'Local WebSocket port for the UXP companion bridge (default 8080).'
        },
        input: { type: 'string', description: 'Existing .blend, image/document, media asset, or project file inside the workspace.' },
        output: { type: 'string', description: 'New .blend, PSD/PNG, PRPROJ, or AEP file inside the workspace.' },
        stages: {
          type: 'array',
          description: 'Stages for studio_pipeline: array of { id, type: "3d_batch"|"studio_batch"|"live_bridge"|"engine_bridge", config }',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Stage identifier' },
              type: {
                type: 'string',
                enum: ['3d_batch', 'studio_batch', 'live_bridge', 'engine_bridge'],
                description: 'Stage batch execution type'
              },
              config: {
                type: 'object',
                description: 'Stage payload configuration',
                properties: {
                  host: { type: 'string' },
                  engine: { type: 'string' },
                  liveOperation: { type: 'string' },
                  engineOperation: { type: 'string' },
                  input: { type: 'string' },
                  output: { type: 'string' },
                  actions: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        type: { type: 'string' }
                      }
                    }
                  }
                }
              }
            },
            required: ['type']
          }
        },
        actions: { type: 'array', maxItems: 64, items: {
          type: 'object', properties: {
            type: { type: 'string', enum: [
              'add_cube', 'add_sphere', 'add_cylinder', 'add_plane', 'add_camera', 'add_light',
              'material', 'render', 'transform', 'resize', 'rotate', 'crop', 'layer', 'new_layer', 'flatten',
              'composition', 'sequence', 'import', 'text', 'marker', 'cut', 'solid', 'adjust_color'
            ] },
            name: { type: 'string' },
            width: { type: 'number' }, height: { type: 'number' },
            angle: { type: 'number' }, index: { type: 'integer' },
            opacity: { type: 'number' }, visible: { type: 'boolean' },
            duration: { type: 'number' }, fps: { type: 'number' },
            path: { type: 'string' }, start: { type: 'number' }, text: { type: 'string' },
            location: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
            scale: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
            rotation: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 },
            radius: { type: 'number' }, depth: { type: 'number' },
            lightType: { type: 'string', enum: ['POINT', 'SUN', 'SPOT', 'AREA'] },
            energy: { type: 'number' },
            color: { type: 'array', items: { type: 'number' }, minItems: 4, maxItems: 4 },
            outputPath: { type: 'string' },
            resolution: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
            comment: { type: 'string' },
            track: { type: 'integer' },
            time: { type: 'number' },
            left: { type: 'number' },
            top: { type: 'number' },
            blendMode: { type: 'string' },
            size: { type: 'number' },
            font: { type: 'string' },
            x: { type: 'number' },
            y: { type: 'number' },
            brightness: { type: 'number' },
            contrast: { type: 'number' },
            roughness: { type: 'number' },
            metallic: { type: 'number' }
          }, required: ['type'], additionalProperties: false
        } }
      }, required: ['action'], additionalProperties: false
    }
  },
  async execute(value: unknown, context: { signal?: AbortSignal } = {}) {
    try {
      if (!value || typeof value !== 'object') throw new Error('Expected creative app arguments');
      const args = value as Record<string, unknown>;
      if (args.action === 'status') return { success: true, apps: await creativeAppStatus() };
      if (args.action === 'studio_edit') return await runStudioEdit(args, process.cwd(), context.signal);
      if (args.action === 'blender_batch') return await runBlenderBatch(args, process.cwd(), context.signal);
      if (args.action === 'studio_pipeline') return await runStudioPipeline(args, process.cwd(), context.signal);
      if (args.action === 'live_bridge') return await runAdobeLiveBridge(args, process.cwd(), context.signal);
      if (args.action === 'engine_bridge') return await runGameEngineBridge(args, process.cwd(), context.signal);
      if (args.action === 'verify_bridge') return await verifyAllCreativeAndGameBridges(process.cwd());
      if (args.action === 'scaffold_uxp') {
        return await scaffoldCausyneUxpPlugin(
          typeof args.outputDir === 'string' && args.outputDir.trim()
            ? args.outputDir.trim()
            : typeof args.output === 'string' && args.output.trim()
            ? args.output.trim()
            : 'causyne-uxp-bridge',
          process.cwd(),
          { websocketPort: typeof args.websocketPort === 'number' ? args.websocketPort : undefined }
        );
      }
      throw new Error('Unknown creative app action');
    } catch (error) { return { success: false, error: error instanceof Error ? error.message : String(error) }; }
  }
};
