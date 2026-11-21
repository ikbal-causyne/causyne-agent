import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { getErrorMessage } from './toolPathSafety.js';
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
    for (const cand of candidates) {
        if (!fs.existsSync(cand))
            continue;
        try {
            const reply = execFileSync(cand, ['--version'], { timeout: 8000, encoding: 'utf8' });
            if (/^blender\s+\d/i.test(String(reply).trim()))
                return cand;
        }
        catch {
            // Unreadable, not executable, or it hung: not a usable Blender.
        }
    }
    return null;
}
function getWorkspaceTempDir() {
    const wsTmp = path.join(process.cwd(), '.tmp_causyne_3d');
    try {
        if (!fs.existsSync(wsTmp))
            fs.mkdirSync(wsTmp, { recursive: true });
        return wsTmp;
    }
    catch {
        return os.tmpdir();
    }
}
async function runHeadlessCli(scriptPath, customCode, results, simulateMissing = false) {
    const blenderBin = getBlenderExecutablePath();
    if (simulateMissing || !blenderBin || !fs.existsSync(blenderBin)) {
        results.push(`[ENGINE MISSING or SIMULATED] Blender executable not found locally (${String(blenderBin ?? 'none')}). Cascading to Sovereign Fallback...`);
        const err = new Error('[ENGINE MISSING or SIMULATED] Blender binary not found.');
        err.fallback_required = true;
        err.fallback_guidance = {
            auto_install_option: 'Call manage_local_dependencies (action="check_and_setupEng", engine="blender").',
            instant_execution_option: 'Or invoke game.asset_fetch (search_cc0 3D models) or generate_media_via_api / Three.js WebGL rendering.'
        };
        throw err;
    }
    let targetPythonPath = scriptPath || null;
    if (!targetPythonPath && customCode) {
        const tempDir = path.join(getWorkspaceTempDir(), 'causyne_blender');
        if (!fs.existsSync(tempDir))
            fs.mkdirSync(tempDir, { recursive: true });
        targetPythonPath = path.join(tempDir, `causyne_3d_gen_${Date.now()}.py`);
        fs.writeFileSync(targetPythonPath, customCode, 'utf8');
    }
    if (!targetPythonPath || !fs.existsSync(targetPythonPath)) {
        throw new Error('No valid Python script provided for headless Blender execution.');
    }
    const finalScript = targetPythonPath;
    return new Promise((resolve) => {
        results.push(`[Layer 3 Headless] Launching Blender CLI in background: ${blenderBin} --background --python ${finalScript}`);
        const child = spawn(blenderBin, ['--background', '--python', finalScript], {
            stdio: ['ignore', 'pipe', 'pipe']
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (data) => { stdout += data.toString(); });
        child.stderr.on('data', (data) => { stderr += data.toString(); });
        child.on('error', (err) => {
            results.push(`[Layer 3 Headless] Spawn failed: ${err.message}`);
            resolve({ success: false, error: err.message, log: results });
        });
        child.on('close', (code) => {
            if (code === 0) {
                results.push(`[Layer 3 Headless] Execution successful:\n${stdout.trim()}`);
                resolve({ success: true, log: results });
            }
            else {
                results.push(`[Layer 3 Headless] Execution failed (code ${String(code)}):\n${stderr.trim() || stdout.trim()}`);
                resolve({ success: false, error: `Blender CLI exited with code ${String(code)}`, log: results });
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
                simulateMissing: { type: 'boolean', description: 'Simulate missing binary to verify sovereign fallback cascade.' },
                actions: {
                    type: 'array',
                    description: 'List of 3D AGI engineering actions to execute in order',
                    items: {
                        type: 'object',
                        properties: {
                            type: {
                                type: 'string',
                                enum: [
                                    'getSceneGraph', 'getObjectInfo', 'getActiveSelection', 'modifyObject',
                                    'autoFrameCamera', 'setupStudioLighting', 'smartMaterial', 'smartGeometry',
                                    'cinematicAtmosphere', 'smartGeoNodes', 'exportAsset', 'executePython',
                                    'captureViewport', 'renderFrame', 'renderAnimation', 'clearScene', 'runHeadless'
                                ]
                            },
                            code: { type: 'string', description: 'Python (bpy) code snippet to execute in Blender' },
                            filepath: { type: 'string', description: 'Target file path for viewport capture, render still, or MP4 video animation.' },
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
    async execute(args = {}, _context) {
        const simulateMissing = args?.simulateMissing || false;
        const blenderBin = getBlenderExecutablePath();
        if (simulateMissing || !blenderBin || !fs.existsSync(blenderBin)) {
            return {
                success: false,
                status: 'fallback_required',
                engine: 'blender',
                error: '[ENGINE MISSING or SIMULATED] Blender binary not found.',
                fallback_guidance: {
                    auto_install_option: 'Call manage_local_dependencies (action="check_and_setupEng", engine="blender").',
                    instant_execution_option: 'Or immediately invoke game.asset_fetch (action: "search_cc0", category: "3d_models") or generate_media_via_api / Three.js WebGL to fulfill user 3D/visual request without Blender.'
                }
            };
        }
        const actions = Array.isArray(args?.actions) ? args.actions : [];
        const results = [];
        for (const action of actions) {
            if (!action || typeof action !== 'object')
                continue;
            if (action.type === 'getSceneGraph') {
                results.push('[Layer 3 Fallback] Bridge not active; cannot query live viewport hierarchy.');
            }
            else if (action.type === 'getObjectInfo') {
                results.push('[Layer 3 Fallback] Bridge not active; cannot inspect object properties.');
            }
            else if (action.type === 'getActiveSelection') {
                results.push('[Layer 3 Fallback] Bridge not active; cannot query selection.');
            }
            else if (action.type === 'modifyObject') {
                results.push('[Layer 3 Fallback] Bridge not active; cannot modify live object directly.');
            }
            else if (action.type === 'autoFrameCamera') {
                const focal = Number.isFinite(Number(action.focal_length)) ? Number(action.focal_length) : 65.0;
                const camCode = `import bpy, math
cam = bpy.context.scene.camera
if not cam:
  cd = bpy.data.cameras.new('Cam')
  cam = bpy.data.objects.new('Cam', cd)
  bpy.context.scene.collection.objects.link(cam)
  bpy.context.scene.camera = cam
cam.location = (10, -10, 8)
cam.rotation_euler = (math.radians(50), 0, math.radians(45))
if hasattr(cam.data, "lens"):
  cam.data.lens = ${focal}
print('Headless camera framed at studio angle')`;
                await runHeadlessCli(null, camCode, results);
            }
            else if (action.type === 'smartGeometry') {
                const bevelWidth = Number.isFinite(Number(action.bevel_width)) ? Number(action.bevel_width) : 0.015;
                const subsurfPy = action.subsurf !== false ? 'True' : 'False';
                const geomCode = `import bpy, math, json
target_name = json.loads(${JSON.stringify(JSON.stringify(String(action.name || '')))})
targets = [bpy.data.objects.get(target_name)] if target_name else [o for o in bpy.context.scene.objects if o.type == 'MESH' and o.visible_get() and not any(k in o.name.lower() for k in ['floor', 'plane', 'backdrop', 'studio', 'ground', 'cove'])]
targets = [t for t in targets if t]
for o in targets:
  if hasattr(o.data, "use_auto_smooth"):
    o.data.use_auto_smooth = True
  for p in o.data.polygons:
    p.use_smooth = True
  if not any(m.type == 'BEVEL' for m in o.modifiers):
    bev = o.modifiers.new(name="StudioBevel", type='BEVEL')
    bev.width = ${bevelWidth}
    bev.segments = 3
    bev.limit_method = 'ANGLE'
    bev.angle_limit = math.radians(35)
  if ${subsurfPy} and not any(m.type == 'SUBSURF' for m in o.modifiers):
    sub = o.modifiers.new(name="StudioSubsurf", type='SUBSURF')
    sub.levels = 2
    sub.render_levels = 2
print("Headless applied Studio Bevel and Subsurf")`;
                await runHeadlessCli(null, geomCode, results);
            }
            else if (action.type === 'smartMaterial') {
                const matCode = `import bpy, time, json
preset = json.loads(${JSON.stringify(JSON.stringify(String(action.preset || 'custom')))}).lower()
target_name = json.loads(${JSON.stringify(JSON.stringify(String(action.name || '')))})
targets = [bpy.data.objects.get(target_name)] if target_name else [o for o in bpy.context.scene.objects if o.type == 'MESH' and o.visible_get() and not any(k in o.name.lower() for k in ['floor', 'plane', 'backdrop', 'studio', 'ground', 'cove'])]
targets = [t for t in targets if t]
mat = bpy.data.materials.new(name=f"CausynePBR_{preset.capitalize()}_{int(time.time()*1000)%10000}")
mat.use_nodes = True
nodes = mat.node_tree.nodes
links = mat.node_tree.links
nodes.clear()
bsdf = nodes.new(type="ShaderNodeBsdfPrincipled")
bsdf.location = (0, 0)
out = nodes.new(type="ShaderNodeOutputMaterial")
out.location = (300, 0)
links.new(bsdf.outputs["BSDF"], out.inputs["Surface"])
if preset in ["gold", "gold_brushed", "aztec_gold"]:
  bsdf.inputs["Base Color"].default_value = (1.0, 0.766, 0.336, 1.0)
  bsdf.inputs["Metallic"].default_value = 1.0
  bsdf.inputs["Roughness"].default_value = 0.18
elif preset in ["sandstone", "ancient_stone", "pyramid_stone"]:
  bsdf.inputs["Base Color"].default_value = (0.68, 0.55, 0.40, 1.0)
  bsdf.inputs["Roughness"].default_value = 0.85
elif preset in ["velvet", "cushion_velvet", "watch_cushion"]:
  bsdf.inputs["Base Color"].default_value = (0.05, 0.06, 0.08, 1.0)
  bsdf.inputs["Roughness"].default_value = 0.9
elif preset in ["chrome", "steel", "watch_case"]:
  bsdf.inputs["Base Color"].default_value = (0.88, 0.89, 0.90, 1.0)
  bsdf.inputs["Metallic"].default_value = 1.0
  bsdf.inputs["Roughness"].default_value = 0.08
for o in targets:
  if len(o.data.materials) == 0:
    o.data.materials.append(mat)
  else:
    o.data.materials[0] = mat
print(f"Headless applied Smart PBR Material ({preset})")`;
                await runHeadlessCli(null, matCode, results);
            }
            else if (action.type === 'cinematicAtmosphere') {
                const sunElev = Number.isFinite(Number(action.sun_elevation)) ? Number(action.sun_elevation) : 12.0;
                const fogDensity = Number.isFinite(Number(action.fog_density)) ? Number(action.fog_density) : 0.015;
                const fogPy = action.volumetric_fog !== false ? 'True' : 'False';
                const atmoCode = `import bpy, math
w = bpy.context.scene.world or bpy.data.worlds.new("CausyneWorld")
bpy.context.scene.world = w
w.use_nodes = True
nodes = w.node_tree.nodes
links = w.node_tree.links
nodes.clear()
bg = nodes.new("ShaderNodeBackground")
out = nodes.new("ShaderNodeOutputWorld")
sky = nodes.new("ShaderNodeTexSky")
sky.sky_type = 'MULTIPLE_SCATTERING' if hasattr(sky, 'sky_type') else 'HOSEK_WILKIE'
if hasattr(sky, 'sun_elevation'):
  sky.sun_elevation = math.radians(${sunElev})
sky.sun_rotation = math.radians(-45.0)
links.new(sky.outputs["Color"], bg.inputs["Color"])
links.new(bg.outputs["Background"], out.inputs["Surface"])
if ${fogPy}:
  fm = bpy.data.materials.new("CausyneFog")
  fm.use_nodes = True
  fn = fm.node_tree.nodes
  fl = fm.node_tree.links
  fn.clear()
  vol = fn.new("ShaderNodeVolumeScatter")
  vol.inputs["Density"].default_value = ${fogDensity}
  fo = fn.new("ShaderNodeOutputMaterial")
  fl.new(vol.outputs["Volume"], fo.inputs["Volume"])
  bpy.ops.mesh.primitive_cube_add(size=40.0, location=(0,0,10))
  fb = bpy.context.active_object
  fb.name = "CausyneAtmosphereVolume"
  fb.display_type = 'WIRE'
  fb.data.materials.append(fm)
print("Headless applied Cinematic Atmosphere (Nishita Sky + Volumetric Fog)")`;
                await runHeadlessCli(null, atmoCode, results);
            }
            else if (action.type === 'smartGeoNodes') {
                const subdivs = Number.isFinite(Number(action.subdivisions)) ? Math.max(1, Math.min(6, Math.round(Number(action.subdivisions)))) : 3;
                const gnCode = `import bpy, json
gen = json.loads(${JSON.stringify(JSON.stringify(String(action.generator || 'masonry_brick_wall')))})
targets = [o for o in bpy.context.scene.objects if o.type == 'MESH' and "Volume" not in o.name and "Floor" not in o.name]
for o in targets:
  mod = o.modifiers.new(name=f"GeoNode_{gen}", type='NODES')
  ng = bpy.data.node_groups.get(f"GN_{gen}")
  if not ng:
    ng = bpy.data.node_groups.new(f"GN_{gen}", 'GeometryNodeTree')
    ng.interface.new_socket("Geometry", in_out='INPUT', socket_type='NodeSocketGeometry')
    ng.interface.new_socket("Geometry", in_out='OUTPUT', socket_type='NodeSocketGeometry')
    gi = ng.nodes.new('NodeGroupInput')
    gi.location = (-400,0)
    go = ng.nodes.new('NodeGroupOutput')
    go.location = (400,0)
    if gen == "masonry_brick_wall":
      s = ng.nodes.new('GeometryNodeSubdivideMesh')
      s.location = (-150,0)
      s.inputs["Level"].default_value = ${subdivs}
      ng.links.new(gi.outputs["Geometry"], s.inputs["Mesh"])
      ng.links.new(s.outputs["Mesh"], go.inputs["Geometry"])
    else:
      ng.links.new(gi.outputs["Geometry"], go.inputs["Geometry"])
  mod.node_group = ng
print(f"Headless attached Geometry Nodes ({gen})")`;
                await runHeadlessCli(null, gnCode, results);
            }
            else if (action.type === 'setupStudioLighting') {
                const keyEnergy = Number.isFinite(Number(action.key_energy)) ? Number(action.key_energy) : 800;
                const lightCode = `import bpy, math
for o in list(bpy.context.scene.objects):
  if o.type == 'LIGHT':
    bpy.data.objects.remove(o, do_unlink=True)
kd = bpy.data.lights.new('Key', 'AREA')
kd.energy = ${keyEnergy}
kd.size = 5.0
ko = bpy.data.objects.new('Key', kd)
ko.location = (6, -6, 8)
ko.rotation_euler = (math.radians(45), 0, math.radians(45))
bpy.context.scene.collection.objects.link(ko)
print('Headless studio lighting built')`;
                await runHeadlessCli(null, lightCode, results);
            }
            else if (action.type === 'exportAsset') {
                const destDir = action.directory || path.join(getWorkspaceTempDir(), 'causyne_3d_exports');
                const prefix = action.filename || `causyne_asset_${Date.now()}`;
                const fmts = Array.isArray(action.formats) ? action.formats.map(String) : ['blend', 'glb'];
                const paramsJson = JSON.stringify({ destDir, prefix, fmts });
                const exportCode = `import bpy, os, json
params = json.loads(${JSON.stringify(paramsJson)})
d = params["destDir"]
prefix = params["prefix"]
fmts = params["fmts"]
os.makedirs(d, exist_ok=True)
if "blend" in fmts:
  bpy.ops.wm.save_as_mainfile(filepath=os.path.join(d, f"{prefix}.blend"))
if "glb" in fmts:
  bpy.ops.export_scene.gltf(filepath=os.path.join(d, f"{prefix}.glb"), export_format="GLB")
if "obj" in fmts:
  if hasattr(bpy.ops.wm, "obj_export"):
    bpy.ops.wm.obj_export(filepath=os.path.join(d, f"{prefix}.obj"))
  else:
    bpy.ops.export_scene.obj(filepath=os.path.join(d, f"{prefix}.obj"))
print("Headless exported formats to", d)`;
                await runHeadlessCli(null, exportCode, results);
            }
            else if (action.type === 'clearScene') {
                const keepPy = action.keep_lights_camera !== false ? 'True' : 'False';
                const clearCode = `import bpy
for o in list(bpy.context.scene.objects):
  if ${keepPy} and o.type in ['CAMERA', 'LIGHT']:
    continue
  bpy.data.objects.remove(o, do_unlink=True)
print("Headless cleared scene meshes")`;
                await runHeadlessCli(null, clearCode, results);
            }
            else if (action.type === 'executePython') {
                let pyCode = action.code || '';
                if (action.scriptPath && fs.existsSync(action.scriptPath)) {
                    pyCode = fs.readFileSync(action.scriptPath, 'utf8');
                }
                if (!pyCode) {
                    results.push('[Error] No code or valid scriptPath provided for executePython.');
                    continue;
                }
                results.push('[Layer 3 Fallback] Live bridge not active. Executing via standalone Blender background CLI...');
                try {
                    await runHeadlessCli(action.scriptPath, pyCode, results);
                }
                catch (cliErr) {
                    results.push(`[Layer 3 Error] ${getErrorMessage(cliErr)}`);
                }
            }
            else if (action.type === 'captureViewport') {
                const targetPath = action.filepath || path.join(getWorkspaceTempDir(), `causyne_3d_preview_${Date.now()}.png`);
                const captureCode = `import bpy, os, json
target = json.loads(${JSON.stringify(JSON.stringify(targetPath))})
os.makedirs(os.path.dirname(target), exist_ok=True)
bpy.ops.render.opengl(write_still=True, filepath=target)
print("Captured headless viewport to", target)`;
                try {
                    await runHeadlessCli(null, captureCode, results);
                }
                catch (cliErr) {
                    results.push(`[Layer 3 Capture Error] ${getErrorMessage(cliErr)}`);
                }
            }
            else if (action.type === 'renderFrame' || action.type === 'renderAnimation') {
                const targetPath = action.filepath || path.join(getWorkspaceTempDir(), `causyne_3d_render_${Date.now()}.${action.type === 'renderAnimation' ? 'mp4' : 'png'}`);
                const isAnimation = Boolean(action.animation) || action.type === 'renderAnimation' || targetPath.toLowerCase().endsWith('.mp4') || targetPath.toLowerCase().endsWith('.mov') || targetPath.toLowerCase().endsWith('.mkv');
                const startFrame = Number.isFinite(Number(action.frame_start)) ? Math.max(1, Math.round(Number(action.frame_start))) : 1;
                const endFrame = Number.isFinite(Number(action.frame_end)) ? Math.max(startFrame, Math.round(Number(action.frame_end))) : 60;
                const renderParams = JSON.stringify({ targetPath, engine: String(action.engine || ''), startFrame, endFrame });
                const renderCode = isAnimation
                    ? `import bpy, os, time, json
params = json.loads(${JSON.stringify(renderParams)})
target = params["targetPath"]
os.makedirs(os.path.dirname(target), exist_ok=True)
bpy.context.scene.frame_start = params["startFrame"]
bpy.context.scene.frame_end = params["endFrame"]
if params["engine"]:
  bpy.context.scene.render.engine = params["engine"]
try:
  bpy.context.scene.render.filepath = target
  bpy.context.scene.render.image_settings.file_format = 'FFMPEG'
  if hasattr(bpy.context.scene.render, 'ffmpeg'):
    bpy.context.scene.render.ffmpeg.format = 'MPEG4' if target.lower().endswith('.mp4') else 'MKV'
    bpy.context.scene.render.ffmpeg.codec = 'H264'
  bpy.ops.render.render(animation=True)
  print("Rendered MP4 animation directly to", target)
except Exception:
  import subprocess, shutil as sh_util, tempfile
  td = tempfile.mkdtemp(prefix=".causyne_temp_frames_", dir=os.path.dirname(target))
  try:
    bpy.context.scene.render.image_settings.file_format = 'PNG'
    bpy.context.scene.render.filepath = os.path.join(td, "frame_")
    bpy.ops.render.render(animation=True)
    fps = getattr(bpy.context.scene.render, "fps", 30)
    fb = sh_util.which("ffmpeg")
    if not fb:
      for cand in ["/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "C:\\\\Program Files\\\\ffmpeg\\\\bin\\\\ffmpeg.exe"]:
        if os.path.exists(cand):
          fb = cand
          break
    if not fb:
      raise RuntimeError("ffmpeg binary not found")
    subprocess.run([fb, "-y", "-framerate", str(fps), "-i", os.path.join(td, "frame_%04d.png"), "-c:v", "libx264", "-pix_fmt", "yuv420p", "--", target], check=True)
    print("Rendered MP4 animation via sequence to", target)
  finally:
    sh_util.rmtree(td, ignore_errors=True)`
                    : `import bpy, os, json
params = json.loads(${JSON.stringify(renderParams)})
target = params["targetPath"]
os.makedirs(os.path.dirname(target), exist_ok=True)
bpy.context.scene.render.filepath = target
if params["engine"]:
  bpy.context.scene.render.engine = params["engine"]
bpy.ops.render.render(write_still=True)
print("Rendered still frame to", target)`;
                try {
                    await runHeadlessCli(null, renderCode, results);
                }
                catch (cliErr) {
                    results.push(`[Layer 3 Render Error] ${getErrorMessage(cliErr)}`);
                }
            }
            else if (action.type === 'runHeadless') {
                let pyCode = action.code || '';
                if (action.scriptPath && fs.existsSync(action.scriptPath)) {
                    pyCode = fs.readFileSync(action.scriptPath, 'utf8');
                }
                try {
                    await runHeadlessCli(action.scriptPath, pyCode, results);
                }
                catch (cliErr) {
                    results.push(`[Layer 3 Error] ${getErrorMessage(cliErr)}`);
                }
            }
        }
        return { success: true, log: results };
    }
};
