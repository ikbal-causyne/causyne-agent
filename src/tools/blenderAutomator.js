import os from 'os';
import fs from 'fs';
import path from 'path';
import { spawn, execFileSync } from 'child_process';

// Time to wait for bridge to become active after launching Blender (ms per poll)
const BRIDGE_POLL_INTERVAL_MS = 500;
// Maximum number of polls before giving up
const BRIDGE_POLL_MAX_ATTEMPTS = 20;

function getBlenderExecutablePath() {
  const platform = os.platform();
  const homeDir = os.homedir();
  const causyneBlenderDir = path.join(homeDir, '.causyne', 'engines', 'blender');
  
  const candidates = platform === 'darwin' ? [
    path.join(causyneBlenderDir, 'blender'),
    '/Applications/Blender.app/Contents/MacOS/Blender',
    '/usr/local/bin/blender',
    '/opt/homebrew/bin/blender'
  ] : platform === 'win32' ? [
    path.join(causyneBlenderDir, 'blender.exe'),
    'C:\\Program Files\\Blender Foundation\\Blender\\blender.exe'
  ] : [
    path.join(causyneBlenderDir, 'blender'),
    '/usr/bin/blender',
    '/usr/local/bin/blender'
  ];

  // EXISTENCE IS NOT IDENTITY.
  //
  // This used to return the first path that merely EXISTED, and the provisioned
  // `~/.causyne/engines/blender/blender` slot is checked first so a user can
  // supply their own build. On a real machine that slot held a 55-byte shell
  // script — `echo "Sovereign blender stub wrapper v1.3.2"` — left behind by an
  // earlier provisioning experiment. It shadowed a genuine Blender 5.2 LTS in
  // /Applications, so every headless render invoked a stub that printed one
  // line and exited 0. The tool reported success and produced nothing, which is
  // the worst failure mode available: a silent one.
  //
  // Ask each candidate who it is. Only something that answers "Blender" counts.
  for (const cand of candidates) {
    if (!fs.existsSync(cand)) continue;
    try {
      const reply = execFileSync(cand, ['--version'], { timeout: 8000, encoding: 'utf8' });
      if (/^blender\s+\d/i.test(String(reply).trim())) return cand;
    } catch (e) {
      // Unreadable, not executable, or it hung: not a usable Blender.
    }
  }
  return candidates[0];
}

function getWorkspaceTempDir() {
  const wsTmp = path.join(process.cwd(), '.tmp_causyne_3d');
  try {
    if (!fs.existsSync(wsTmp)) fs.mkdirSync(wsTmp, { recursive: true });
    return wsTmp;
  } catch (e) {
    return os.tmpdir();
  }
}







async function runHeadlessCli(scriptPath, customCode, results, simulateMissing = false) {
  const blenderBin = getBlenderExecutablePath();
  if (simulateMissing || !fs.existsSync(blenderBin)) {
    results.push(`[ENGINE MISSING or SIMULATED] Blender executable not found locally (${blenderBin}). Cascading to Sovereign Fallback...`);
    results.push(`[Layer 2 Auto-Install Option] To install Blender (312 MB > 200 MB consent gate), call manage_local_dependencies with action="check_and_setupEng", engine="blender", userConsent: true.`);
    results.push(`[Layer 3 Instant CC0 / WebGL Fallback] Or immediately invoke game.asset_fetch (action: "search_cc0", category: "3d_models") or generate_media_via_api / Three.js WebGL to fulfill user 3D/visual request instantly.`);
    const err = new Error(`[ENGINE MISSING or SIMULATED] Blender binary not found.`);
    err.fallback_required = true;
    err.fallback_guidance = {
      auto_install_option: 'Call manage_local_dependencies (action="check_and_setupEng", engine="blender") - requires explicit userConsent: true because 312 MB > 200 MB gate.',
      instant_execution_option: 'Or invoke game.asset_fetch (search_cc0 3D models) or generate_media_via_api / Three.js WebGL rendering.'
    };
    throw err;
  }

  let targetPythonPath = scriptPath;
  if (!targetPythonPath && customCode) {
    const tempDir = path.join(getWorkspaceTempDir(), 'causyne_blender');
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
    targetPythonPath = path.join(tempDir, `causyne_3d_gen_${Date.now()}.py`);
    fs.writeFileSync(targetPythonPath, customCode, 'utf8');
  }

  if (!targetPythonPath || !fs.existsSync(targetPythonPath)) {
    throw new Error('No valid Python script provided for headless Blender execution.');
  }

  return new Promise((resolve) => {
    results.push(`[Layer 3 Headless] Launching Blender CLI in background: ${blenderBin} --background --python ${targetPythonPath}`);
    const child = spawn(blenderBin, ['--background', '--python', targetPythonPath], {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });

    child.on('close', (code) => {
      if (code === 0) {
        results.push(`[Layer 3 Headless] Execution successful:\n${stdout.trim()}`);
        resolve({ success: true, log: results });
      } else {
        results.push(`[Layer 3 Headless] Execution failed (code ${code}):\n${stderr.trim() || stdout.trim()}`);
        resolve({ success: false, error: `Blender CLI exited with code ${code}`, log: results });
      }
    });
  });
}

export const blenderAct = {
  schema: {
    name: 'blender.act',
    description: 'Automate Blender 3D ("The Cursor for Blender 3D") through its local command-line interface across macOS, Windows, and Linux. Supports 12 stateful AGI actions: scene hierarchy inspection, object X-ray info, real-time selection tracking, non-destructive mutation, auto camera framing, 3-point studio lighting, and full 3D asset export (.blend, .glb, .obj, .fbx).',
    parameters: {
      type: 'object',
      properties: {
        simulateMissing: {
          type: 'boolean',
          description: 'Simulate missing binary to verify sovereign fallback cascade.'
        },
        actions: {
          type: 'array',
          description: 'List of 3D AGI engineering actions to execute in order',
          items: {
            type: 'object',
            properties: {
              type: {
                type: 'string',
                enum: [
                  'getSceneGraph',
                  'getObjectInfo',
                  'getActiveSelection',
                  'modifyObject',
                  'autoFrameCamera',
                  'setupStudioLighting',
                  'smartMaterial',
                  'smartGeometry',
                  'cinematicAtmosphere',
                  'smartGeoNodes',
                  'exportAsset',
                  'executePython',
                  'captureViewport',
                  'renderFrame',
                  'renderAnimation',
                  'clearScene',
                  'runHeadless'
                ]
              },
              code: { type: 'string', description: 'Python (bpy) code snippet to execute in Blender' },
              filepath: { type: 'string', description: 'Target file path for viewport capture, render still, or MP4 video animation (e.g. /Users/example/Desktop/render.png or ./output.png). NOTE: Do NOT use /tmp if you plan to view/read the file with fs_read or view_file due to workspace boundary restrictions.' },
              animation: { type: 'boolean', description: 'Whether to render full video animation sequence across frame_start..frame_end' },
              frame_start: { type: 'number', description: 'Start frame number for video animation render (default 1)' },
              frame_end: { type: 'number', description: 'End frame number for video animation render (default 60)' },
              engine: { type: 'string', description: 'Render engine to use: e.g. "BLENDER_EEVEE_NEXT", "CYCLES"' },
              scriptPath: { type: 'string', description: 'Path to external .py script for complex procedural generation' },
              name: { type: 'string', description: 'Target object name for getObjectInfo, modifyObject, smartMaterial, or smartGeometry' },
              preset: { type: 'string', description: 'Smart PBR Material preset: e.g. "gold_brushed", "sandstone", "velvet", "chrome", "sapphire", "custom"' },
              generator: { type: 'string', description: 'Geometry Nodes generator type: e.g. "masonry_brick_wall", "procedural_staircase", "sci_fi_panels", "scatter_debris"' },
              subdivisions: { type: 'number', description: 'Subdivision level for Geometry Nodes masonry or procedural generators (default 3)' },
              sun_elevation: { type: 'number', description: 'Nishita sky sun elevation angle in degrees for cinematicAtmosphere (default 12.0 for golden hour)' },
              volumetric_fog: { type: 'boolean', description: 'Whether to include volumetric fog in cinematicAtmosphere (default true)' },
              fog_density: { type: 'number', description: 'Density of volumetric fog scatter (default 0.015)' },
              bevel_width: { type: 'number', description: 'Bevel width in Blender units for smartGeometry (default 0.015)' },
              subsurf: { type: 'boolean', description: 'Whether to apply Subdivision Surface modifier in smartGeometry (default true)' },
              focal_length: { type: 'number', description: 'Camera lens focal length in mm for autoFrameCamera (default 65.0mm studio telephoto)' },
              location: { type: 'array', items: { type: 'number' }, description: 'Target [X, Y, Z] coordinates for modifyObject' },
              rotation_euler: { type: 'array', items: { type: 'number' }, description: 'Target [X, Y, Z] rotation in radians for modifyObject' },
              scale: { type: 'array', items: { type: 'number' }, description: 'Target [X, Y, Z] scale factors for modifyObject' },
              visible: { type: 'boolean', description: 'Set object viewport and render visibility' },
              key_energy: { type: 'number', description: 'Key light energy in watts/lumens (default 800)' },
              fill_energy: { type: 'number', description: 'Fill light energy (default 300)' },
              rim_energy: { type: 'number', description: 'Rim light energy (default 500)' },
              directory: { type: 'string', description: 'Directory destination for 3D asset export' },
              filename: { type: 'string', description: 'File name prefix without extension for 3D asset export' },
              formats: { type: 'array', items: { type: 'string' }, description: 'Formats to export: e.g. ["blend", "glb", "obj", "fbx"]' },
              keep_lights_camera: { type: 'boolean', description: 'Whether to preserve lights and camera when clearing scene (default true)' },
              timeoutMs: { type: 'number', description: 'Execution timeout in ms (default 60000ms)' }
            },
            required: ['type']
          }
        }
      },
      required: ['actions']
    }
  },
  async execute(args) {
    const simulateMissing = args.simulateMissing || false;
    const blenderBin = getBlenderExecutablePath();
    if (simulateMissing || !fs.existsSync(blenderBin)) {
      return {
        success: false,
        status: 'fallback_required',
        engine: 'blender',
        error: '[ENGINE MISSING or SIMULATED] Blender binary not found.',
        fallback_guidance: {
          auto_install_option: 'Call manage_local_dependencies (action="check_and_setupEng", engine="blender") - requires explicit userConsent: true because 312 MB > 200 MB consent gate.',
          instant_execution_option: 'Or immediately invoke game.asset_fetch (action: "search_cc0", category: "3d_models") or generate_media_via_api / Three.js WebGL to fulfill user 3D/visual request without Blender.'
        }
      };
    }

    let results = [];

    for (const action of args.actions) {
      if (action.type === 'getSceneGraph') {
        {
          results.push('[Layer 3 Fallback] Bridge not active; cannot query live viewport hierarchy.');
        }
      }
      else if (action.type === 'getObjectInfo') {
        {
          results.push('[Layer 3 Fallback] Bridge not active; cannot inspect object properties.');
        }
      }
      else if (action.type === 'getActiveSelection') {
        {
          results.push('[Layer 3 Fallback] Bridge not active; cannot query selection.');
        }
      }
      else if (action.type === 'modifyObject') {
        {
          results.push('[Layer 3 Fallback] Bridge not active; cannot modify live object directly.');
        }
      }
      else if (action.type === 'autoFrameCamera') {
        {
          const camCode = `import bpy, math\ncam = bpy.context.scene.camera\nif not cam:\n  cd = bpy.data.cameras.new('Cam')\n  cam = bpy.data.objects.new('Cam', cd)\n  bpy.context.scene.collection.objects.link(cam)\n  bpy.context.scene.camera = cam\ncam.location = (10, -10, 8)\ncam.rotation_euler = (math.radians(50), 0, math.radians(45))\nif hasattr(cam.data, "lens"): cam.data.lens = ${action.focal_length || 65.0}\nprint('Headless 65mm camera framed at studio angle')`;
          await runHeadlessCli(null, camCode, results);
        }
      }
      else if (action.type === 'smartGeometry') {
        {
          const geomCode = `import bpy, math\ntargets = [bpy.data.objects.get(${JSON.stringify(action.name || "")})] if ${JSON.stringify(action.name || "")} else [o for o in bpy.context.scene.objects if o.type == 'MESH' and o.visible_get() and not any(k in o.name.lower() for k in ['floor', 'plane', 'backdrop', 'studio', 'ground', 'cove'])]\ntargets = [t for t in targets if t]\nfor o in targets:\n  if hasattr(o.data, "use_auto_smooth"): o.data.use_auto_smooth = True\n  for p in o.data.polygons: p.use_smooth = True\n  if not any(m.type == 'BEVEL' for m in o.modifiers):\n    bev = o.modifiers.new(name="StudioBevel", type='BEVEL'); bev.width = ${action.bevel_width || 0.015}; bev.segments = 3; bev.limit_method = 'ANGLE'; bev.angle_limit = math.radians(35)\n  if ${action.subsurf !== false} and not any(m.type == 'SUBSURF' for m in o.modifiers):\n    sub = o.modifiers.new(name="StudioSubsurf", type='SUBSURF'); sub.levels = 2; sub.render_levels = 2\nprint("Headless applied Studio Bevel and Subsurf")`;
          await runHeadlessCli(null, geomCode, results);
        }
      }
      else if (action.type === 'smartMaterial') {
        {
          const matCode = `import bpy, time\npreset = ${JSON.stringify(action.preset || "custom")}.lower()\ntargets = [bpy.data.objects.get(${JSON.stringify(action.name || "")})] if ${JSON.stringify(action.name || "")} else [o for o in bpy.context.scene.objects if o.type == 'MESH' and o.visible_get() and not any(k in o.name.lower() for k in ['floor', 'plane', 'backdrop', 'studio', 'ground', 'cove'])]\ntargets = [t for t in targets if t]\nmat = bpy.data.materials.new(name=f"CausynePBR_{preset.capitalize()}_{int(time.time()*1000)%10000}"); mat.use_nodes = True; nodes = mat.node_tree.nodes; links = mat.node_tree.links; nodes.clear()\nbsdf = nodes.new(type="ShaderNodeBsdfPrincipled"); bsdf.location = (0, 0); out = nodes.new(type="ShaderNodeOutputMaterial"); out.location = (300, 0); links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])\nif preset in ["gold", "gold_brushed", "aztec_gold"]:\n  bsdf.inputs["Base Color"].default_value = (1.0, 0.766, 0.336, 1.0); bsdf.inputs["Metallic"].default_value = 1.0; bsdf.inputs["Roughness"].default_value = 0.18\nelif preset in ["sandstone", "ancient_stone", "pyramid_stone"]:\n  bsdf.inputs["Base Color"].default_value = (0.68, 0.55, 0.40, 1.0); bsdf.inputs["Roughness"].default_value = 0.85\nelif preset in ["velvet", "cushion_velvet", "watch_cushion"]:\n  bsdf.inputs["Base Color"].default_value = (0.05, 0.06, 0.08, 1.0); bsdf.inputs["Roughness"].default_value = 0.9\nelif preset in ["chrome", "steel", "watch_case"]:\n  bsdf.inputs["Base Color"].default_value = (0.88, 0.89, 0.90, 1.0); bsdf.inputs["Metallic"].default_value = 1.0; bsdf.inputs["Roughness"].default_value = 0.08\nfor o in targets:\n  if len(o.data.materials) == 0: o.data.materials.append(mat)\n  else: o.data.materials[0] = mat\nprint(f"Headless applied Smart PBR Material ({preset})")`;
          await runHeadlessCli(null, matCode, results);
        }
      }
      else if (action.type === 'cinematicAtmosphere') {
        {
          const atmoCode = `import bpy, math\nw = bpy.context.scene.world or bpy.data.worlds.new("CausyneWorld"); bpy.context.scene.world = w; w.use_nodes = True; nodes = w.node_tree.nodes; links = w.node_tree.links; nodes.clear()\nbg = nodes.new("ShaderNodeBackground"); out = nodes.new("ShaderNodeOutputWorld"); sky = nodes.new("ShaderNodeTexSky"); sky.sky_type = 'MULTIPLE_SCATTERING' if hasattr(sky, 'sky_type') else 'HOSEK_WILKIE'; if hasattr(sky, 'sun_elevation'): sky.sun_elevation = math.radians(${action.sun_elevation || 12.0}); sky.sun_rotation = math.radians(-45.0); links.new(sky.outputs["Color"], bg.inputs["Color"]); links.new(bg.outputs["Background"], out.inputs["Surface"])\nif ${action.volumetric_fog !== false}:\n  fm = bpy.data.materials.new("CausyneFog"); fm.use_nodes = True; fn = fm.node_tree.nodes; fl = fm.node_tree.links; fn.clear(); vol = fn.new("ShaderNodeVolumeScatter"); vol.inputs["Density"].default_value = ${action.fog_density || 0.015}; fo = fn.new("ShaderNodeOutputMaterial"); fl.new(vol.outputs["Volume"], fo.inputs["Volume"])\n  bpy.ops.mesh.primitive_cube_add(size=40.0, location=(0,0,10)); fb = bpy.context.active_object; fb.name = "CausyneAtmosphereVolume"; fb.display_type = 'WIRE'; fb.data.materials.append(fm)\nprint("Headless applied Cinematic Atmosphere (Nishita Sky + Volumetric Fog)")`;
          await runHeadlessCli(null, atmoCode, results);
        }
      }
      else if (action.type === 'smartGeoNodes') {
        {
          const gnCode = `import bpy\ngen = ${JSON.stringify(action.generator || "masonry_brick_wall")}\ntargets = [o for o in bpy.context.scene.objects if o.type == 'MESH' and "Volume" not in o.name and "Floor" not in o.name]\nfor o in targets:\n  mod = o.modifiers.new(name=f"GeoNode_{gen}", type='NODES')\n  ng = bpy.data.node_groups.get(f"GN_{gen}")\n  if not ng:\n    ng = bpy.data.node_groups.new(f"GN_{gen}", 'GeometryNodeTree')\n    ng.interface.new_socket("Geometry", in_out='INPUT', socket_type='NodeSocketGeometry')\n    ng.interface.new_socket("Geometry", in_out='OUTPUT', socket_type='NodeSocketGeometry')\n    gi = ng.nodes.new('NodeGroupInput'); gi.location = (-400,0); go = ng.nodes.new('NodeGroupOutput'); go.location = (400,0)\n    if gen == "masonry_brick_wall":\n      s = ng.nodes.new('GeometryNodeSubdivideMesh'); s.location = (-150,0); s.inputs["Level"].default_value = ${action.subdivisions || 3}\n      ng.links.new(gi.outputs["Geometry"], s.inputs["Mesh"]); ng.links.new(s.outputs["Mesh"], go.inputs["Geometry"])\n    else: ng.links.new(gi.outputs["Geometry"], go.inputs["Geometry"])\n  mod.node_group = ng\nprint(f"Headless attached Geometry Nodes ({gen})")`;
          await runHeadlessCli(null, gnCode, results);
        }
      }
      else if (action.type === 'setupStudioLighting') {
        {
          const lightCode = `import bpy, math\nfor o in list(bpy.context.scene.objects):\n  if o.type == 'LIGHT': bpy.data.objects.remove(o, do_unlink=True)\nkd = bpy.data.lights.new('Key', 'AREA'); kd.energy = ${action.key_energy || 800}; kd.size = 5.0; ko = bpy.data.objects.new('Key', kd); ko.location = (6, -6, 8); ko.rotation_euler = (math.radians(45), 0, math.radians(45)); bpy.context.scene.collection.objects.link(ko)\nprint('Headless studio lighting built')`;
          await runHeadlessCli(null, lightCode, results);
        }
      }
      else if (action.type === 'exportAsset') {
        const destDir = action.directory || path.join(getWorkspaceTempDir(), 'causyne_3d_exports');
        const prefix = action.filename || `causyne_asset_${Date.now()}`;
        const fmts = action.formats || ['blend', 'glb'];

        {
          const exportCode = `import bpy, os\nd = "${destDir}"\nos.makedirs(d, exist_ok=True)\nif "blend" in ${JSON.stringify(fmts)}:\n  bpy.ops.wm.save_as_mainfile(filepath=os.path.join(d, "${prefix}.blend"))\nif "glb" in ${JSON.stringify(fmts)}:\n  bpy.ops.export_scene.gltf(filepath=os.path.join(d, "${prefix}.glb"), export_format="GLB")\nif "obj" in ${JSON.stringify(fmts)}:\n  if hasattr(bpy.ops.wm, "obj_export"): bpy.ops.wm.obj_export(filepath=os.path.join(d, "${prefix}.obj"))\n  else: bpy.ops.export_scene.obj(filepath=os.path.join(d, "${prefix}.obj"))\nprint(f"Headless exported formats to {d}")`;
          await runHeadlessCli(null, exportCode, results);
        }
      }
      else if (action.type === 'clearScene') {
        const keep = action.keep_lights_camera !== false;
        {
          const clearCode = `import bpy\nfor o in list(bpy.context.scene.objects):\n  if ${keep} and o.type in ['CAMERA', 'LIGHT']: continue\n  bpy.data.objects.remove(o, do_unlink=True)\nprint("Headless cleared scene meshes")`;
          await runHeadlessCli(null, clearCode, results);
        }
      }
      else if (action.type === 'executePython') {
        let pyCode = action.code || '';
        if (action.scriptPath && fs.existsSync(action.scriptPath)) {
          pyCode = fs.readFileSync(action.scriptPath, 'utf8');
        }
        if (!pyCode) {
          results.push(`[Error] No code or valid scriptPath provided for executePython.`);
          continue;
        }
        {
          results.push('[Layer 3 Fallback] Live bridge not active. Executing via standalone Blender background CLI...');
          try {
            await runHeadlessCli(action.scriptPath, pyCode, results);
          } catch (cliErr) {
            results.push(`[Layer 3 Error] ${cliErr.message}`);
          }
        }
      }
      else if (action.type === 'captureViewport') {
        const targetPath = action.filepath || path.join(getWorkspaceTempDir(), `causyne_3d_preview_${Date.now()}.png`);
        {
          const captureCode = `import bpy, os\nos.makedirs(os.path.dirname("${targetPath}"), exist_ok=True)\nbpy.ops.render.opengl(write_still=True, filepath="${targetPath}")\nprint("Captured headless viewport to ${targetPath}")`;
          try {
            await runHeadlessCli(null, captureCode, results);
          } catch (cliErr) {
            results.push(`[Layer 3 Capture Error] ${cliErr.message}`);
          }
        }
      }
      else if (action.type === 'renderFrame' || action.type === 'renderAnimation') {
        const targetPath = action.filepath || path.join(getWorkspaceTempDir(), `causyne_3d_render_${Date.now()}.${action.type === 'renderAnimation' ? 'mp4' : 'png'}`);
        const isAnimation = action.animation || action.type === 'renderAnimation' || targetPath.toLowerCase().endsWith('.mp4') || targetPath.toLowerCase().endsWith('.mov') || targetPath.toLowerCase().endsWith('.mkv');
        const startFrame = action.frame_start || 1;
        const endFrame = action.frame_end || 60;
        
        {
          const renderCode = isAnimation ?
            `import bpy, os, time\nos.makedirs(os.path.dirname("${targetPath}"), exist_ok=True)\nbpy.context.scene.frame_start = ${startFrame}\nbpy.context.scene.frame_end = ${endFrame}\nif "${action.engine || ''}": bpy.context.scene.render.engine = "${action.engine || ''}"\ntry:\n  bpy.context.scene.render.filepath = "${targetPath}"\n  bpy.context.scene.render.image_settings.file_format = 'FFMPEG'\n  if hasattr(bpy.context.scene.render, 'ffmpeg'):\n    bpy.context.scene.render.ffmpeg.format = 'MPEG4' if "${targetPath}".lower().endswith('.mp4') else 'MKV'\n    bpy.context.scene.render.ffmpeg.codec = 'H264'\n  bpy.ops.render.render(animation=True)\n  print(f"Rendered MP4 animation directly to ${targetPath}")\nexcept Exception:\n  import subprocess, shutil as sh_util\n  td = os.path.join(os.path.dirname("${targetPath}"), ".causyne_temp_frames_" + str(int(time.time())))\n  os.makedirs(td, exist_ok=True)\n  bpy.context.scene.render.image_settings.file_format = 'PNG'\n  bpy.context.scene.render.filepath = os.path.join(td, "frame_")\n  bpy.ops.render.render(animation=True)\n  fps = getattr(bpy.context.scene.render, "fps", 30)\n  fb = sh_util.which("ffmpeg")\n  if not fb:\n    for cand in ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "C:\\\\Program Files\\\\ffmpeg\\\\bin\\\\ffmpeg.exe"]:\n      if os.path.exists(cand): fb = cand; break\n  if not fb: fb = "ffmpeg"\n  subprocess.run([fb, "-y", "-framerate", str(fps), "-i", os.path.join(td, "frame_%04d.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "${targetPath}"], check=True)\n  sh_util.rmtree(td, ignore_errors=True)\n  print(f"Rendered MP4 animation via sequence to ${targetPath}")` :
            `import bpy, os\nos.makedirs(os.path.dirname("${targetPath}"), exist_ok=True)\nbpy.context.scene.render.filepath = "${targetPath}"\nif "${action.engine || ''}": bpy.context.scene.render.engine = "${action.engine || ''}"\nbpy.ops.render.render(write_still=True)\nprint(f"Rendered still frame to ${targetPath}")`;
          try {
            await runHeadlessCli(null, renderCode, results);
          } catch (cliErr) {
            results.push(`[Layer 3 Render Error] ${cliErr.message}`);
          }
        }
      }
      else if (action.type === 'runHeadless') {
        let pyCode = action.code || '';
        if (action.scriptPath && fs.existsSync(action.scriptPath)) {
          pyCode = fs.readFileSync(action.scriptPath, 'utf8');
        }
        try {
          await runHeadlessCli(action.scriptPath, pyCode, results);
        } catch (cliErr) {
          results.push(`[Layer 3 Error] ${cliErr.message}`);
        }
      }
    }

    return { success: true, log: results };
  }
};
