import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { findBlender } from './apps.js';
const exec = promisify(execFile);
function record(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v))
        throw new Error('Expected a JSON object');
    return v;
}
function vector(v) {
    if (!Array.isArray(v) || v.length !== 3 || !v.every(x => typeof x === 'number' && Number.isFinite(x) && Math.abs(x) <= 1e6))
        throw new Error('A transform requires three finite numbers within +/- 1000000');
    return v;
}
function color(v) {
    if (!Array.isArray(v) || v.length !== 4 || !v.every(x => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1))
        throw new Error('A color requires 4 numbers between 0 and 1 [R, G, B, A]');
    return v;
}
export function parseBatch(value) {
    const job = record(value);
    if (typeof job.output !== 'string' || !job.output.endsWith('.blend'))
        throw new Error('output must be a new .blend file');
    if (job.input !== undefined && (typeof job.input !== 'string' || !job.input.endsWith('.blend')))
        throw new Error('input must be a .blend file');
    if (!Array.isArray(job.actions) || job.actions.length > 64)
        throw new Error('Provide up to 64 actions');
    const actions = job.actions.map((raw) => {
        const a = record(raw);
        if (typeof a.name !== 'string' || !a.name.trim() || a.name.length > 128 || /[\x00-\x1f]/.test(a.name))
            throw new Error('Each action needs an object name (1-128 characters)');
        if (a.type === 'add_cube')
            return { type: a.type, name: a.name, location: a.location === undefined ? [0, 0, 0] : vector(a.location), scale: a.scale === undefined ? [1, 1, 1] : vector(a.scale) };
        if (a.type === 'add_sphere')
            return { type: a.type, name: a.name, location: a.location === undefined ? [0, 0, 0] : vector(a.location), scale: a.scale === undefined ? [1, 1, 1] : vector(a.scale), radius: typeof a.radius === 'number' && Number.isFinite(a.radius) && a.radius > 0 ? a.radius : 1 };
        if (a.type === 'add_cylinder')
            return { type: a.type, name: a.name, location: a.location === undefined ? [0, 0, 0] : vector(a.location), scale: a.scale === undefined ? [1, 1, 1] : vector(a.scale), radius: typeof a.radius === 'number' && Number.isFinite(a.radius) && a.radius > 0 ? a.radius : 1, depth: typeof a.depth === 'number' && Number.isFinite(a.depth) && a.depth > 0 ? a.depth : 2 };
        if (a.type === 'add_plane')
            return { type: a.type, name: a.name, location: a.location === undefined ? [0, 0, 0] : vector(a.location), scale: a.scale === undefined ? [1, 1, 1] : vector(a.scale) };
        if (a.type === 'add_camera')
            return { type: a.type, name: a.name, location: a.location === undefined ? [0, -10, 5] : vector(a.location), ...(a.rotation !== undefined ? { rotation: vector(a.rotation) } : {}) };
        if (a.type === 'add_light')
            return { type: a.type, name: a.name, location: a.location === undefined ? [4, 1, 6] : vector(a.location), lightType: typeof a.lightType === 'string' && ['POINT', 'SUN', 'SPOT', 'AREA'].includes(a.lightType) ? a.lightType : 'POINT', ...(typeof a.energy === 'number' && Number.isFinite(a.energy) ? { energy: a.energy } : {}) };
        if (a.type === 'material') {
            return {
                type: a.type,
                name: a.name,
                color: color(a.color),
                ...(typeof a.roughness === 'number' && Number.isFinite(a.roughness) && a.roughness >= 0 && a.roughness <= 1 ? { roughness: a.roughness } : {}),
                ...(typeof a.metallic === 'number' && Number.isFinite(a.metallic) && a.metallic >= 0 && a.metallic <= 1 ? { metallic: a.metallic } : {})
            };
        }
        if (a.type === 'render') {
            if (typeof a.outputPath !== 'string' || !a.outputPath.trim())
                throw new Error('render action requires an outputPath');
            return { type: a.type, name: a.name, outputPath: a.outputPath, ...(Array.isArray(a.resolution) && a.resolution.length === 2 && a.resolution.every(n => typeof n === 'number' && n > 0) ? { resolution: [a.resolution[0], a.resolution[1]] } : {}) };
        }
        if (a.type === 'transform') {
            if (a.location === undefined && a.scale === undefined && a.rotation === undefined)
                throw new Error('transform requires location or scale');
            return { type: a.type, name: a.name, ...(a.location === undefined ? {} : { location: vector(a.location) }), ...(a.scale === undefined ? {} : { scale: vector(a.scale) }), ...(a.rotation === undefined ? {} : { rotation: vector(a.rotation) }) };
        }
        throw new Error('Unsupported batch action');
    });
    return { output: job.output, actions, ...(typeof job.input === 'string' ? { input: job.input } : {}) };
}
const inside = (root, file) => {
    const relative = path.relative(root, file);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
async function scopedPath(root, name, existing) {
    const target = path.resolve(root, name);
    const resolved = existing ? await fs.realpath(target) : path.join(await fs.realpath(path.dirname(target)), path.basename(target));
    if (!inside(root, resolved))
        throw new Error('Creative files must stay inside the selected workspace');
    if (!existing) {
        try {
            await fs.lstat(target);
            throw new Error('Output already exists; select a new filename');
        }
        catch (error) {
            if (error.code !== 'ENOENT')
                throw error;
        }
    }
    return resolved;
}
// Data and executable Python are separate files. No model-supplied Python is evaluated.
const SCRIPT = `import bpy, json, sys
from pathlib import Path
job = json.loads(Path(sys.argv[sys.argv.index('--') + 1]).read_text())
if job.get('input'):
    bpy.ops.wm.open_mainfile(filepath=job['input'], load_ui=False, use_scripts=False)
else:
    bpy.ops.wm.read_factory_settings(use_empty=True)
for a in job['actions']:
    t = a['type']
    if t == 'add_cube':
        if bpy.data.objects.get(a['name']):
            raise ValueError('Object already exists: ' + a['name'])
        bpy.ops.mesh.primitive_cube_add(location=a['location'])
        obj = bpy.context.object
        obj.name = a['name']
        obj.scale = a['scale']
    elif t == 'add_sphere':
        if bpy.data.objects.get(a['name']):
            raise ValueError('Object already exists: ' + a['name'])
        bpy.ops.mesh.primitive_uv_sphere_add(location=a.get('location', [0, 0, 0]), radius=a.get('radius', 1.0))
        obj = bpy.context.object
        obj.name = a['name']
        obj.scale = a['scale']
    elif t == 'add_cylinder':
        if bpy.data.objects.get(a['name']):
            raise ValueError('Object already exists: ' + a['name'])
        bpy.ops.mesh.primitive_cylinder_add(location=a.get('location', [0, 0, 0]), radius=a.get('radius', 1.0), depth=a.get('depth', 2.0))
        obj = bpy.context.object
        obj.name = a['name']
        obj.scale = a['scale']
    elif t == 'add_plane':
        if bpy.data.objects.get(a['name']):
            raise ValueError('Object already exists: ' + a['name'])
        bpy.ops.mesh.primitive_plane_add(location=a.get('location', [0, 0, 0]))
        obj = bpy.context.object
        obj.name = a['name']
        obj.scale = a['scale']
    elif t == 'add_camera':
        if bpy.data.objects.get(a['name']):
            raise ValueError('Object already exists: ' + a['name'])
        bpy.ops.object.camera_add(location=a.get('location', [0, -10, 5]))
        cam = bpy.context.object
        cam.name = a['name']
        bpy.context.scene.camera = cam
    elif t == 'add_light':
        if bpy.data.objects.get(a['name']):
            raise ValueError('Object already exists: ' + a['name'])
        ltype = a.get('lightType', 'POINT')
        bpy.ops.object.light_add(type=ltype, location=a.get('location', [4, 1, 6]))
        lt = bpy.context.object
        lt.name = a['name']
        if 'energy' in a and hasattr(lt.data, 'energy'):
            lt.data.energy = a['energy']
    elif t == 'material':
        obj = bpy.data.objects.get(a['name'])
        if obj is None:
            raise ValueError('Object not found: ' + a['name'])
        mat = bpy.data.materials.new(name=a['name'] + '_mat')
        mat.use_nodes = True
        bsdf = mat.node_tree.nodes.get('Principled BSDF')
        if bsdf:
            bsdf.inputs['Base Color'].default_value = a['color']
            if 'roughness' in a and 'Roughness' in bsdf.inputs:
                bsdf.inputs['Roughness'].default_value = a['roughness']
            if 'metallic' in a and 'Metallic' in bsdf.inputs:
                bsdf.inputs['Metallic'].default_value = a['metallic']
        if obj.data and hasattr(obj.data, 'materials'):
            obj.data.materials.append(mat)
    elif t == 'transform':
        obj = bpy.data.objects.get(a['name'])
        if obj is None:
            raise ValueError('Object not found: ' + a['name'])
        if 'location' in a: obj.location = a['location']
        if 'scale' in a: obj.scale = a['scale']
        if 'rotation' in a: obj.rotation_euler = a['rotation']
    elif t == 'render':
        if 'outputPath' in a:
            bpy.context.scene.render.filepath = a['outputPath']
            if 'resolution' in a:
                bpy.context.scene.render.resolution_x = a['resolution'][0]
                bpy.context.scene.render.resolution_y = a['resolution'][1]
            bpy.ops.render.render(write_still=True)
bpy.context.view_layer.update()
bpy.context.preferences.filepaths.save_version = 0
bpy.ops.wm.save_as_mainfile(filepath=job['stagedOutput'], check_existing=False, compress=False)
scene = [{'name': o.name, 'type': o.type, 'location': list(o.location), 'scale': list(o.scale)} for o in list(bpy.context.scene.objects)[:200]]
Path(job['result']).write_text(json.dumps({'objects': scene, 'totalObjects': len(bpy.context.scene.objects)}))
`;
export async function runBlenderBatch(value, workspace = process.cwd(), signal) {
    signal?.throwIfAborted();
    const job = parseBatch(value);
    const root = await fs.realpath(workspace);
    const output = await scopedPath(root, job.output, false);
    const input = job.input ? await scopedPath(root, job.input, true) : undefined;
    for (const action of job.actions) {
        if (action.type === 'render') {
            action.outputPath = await scopedPath(root, action.outputPath, false);
        }
    }
    const engine = await findBlender();
    if (!engine)
        throw new Error('Blender is not installed at a supported location');
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'causyne-creative-'));
    const stagedOutput = path.join(path.dirname(output), `.causyne-scene-${randomUUID()}.blend`);
    let reserved = false;
    try {
        const reservation = await fs.open(stagedOutput, 'wx', 0o600);
        await reservation.close();
        reserved = true;
        const script = path.join(temp, 'batch.py');
        const request = path.join(temp, 'job.json');
        const resultFile = path.join(temp, 'result.json');
        await fs.writeFile(script, SCRIPT, { mode: 0o600 });
        await fs.writeFile(request, JSON.stringify({ ...job, input, stagedOutput, result: resultFile }), { mode: 0o600 });
        const env = Object.fromEntries(['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'LANG'].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
        await exec(engine.executable, ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--python', script, '--', request], {
            cwd: root, timeout: 120000, maxBuffer: 1024 * 1024, windowsHide: true, env, ...(signal ? { signal } : {})
        });
        const summary = JSON.parse(await fs.readFile(resultFile, 'utf8'));
        const handle = await fs.open(stagedOutput, 'r');
        try {
            const header = Buffer.alloc(7);
            await handle.read(header, 0, 7, 0);
            if (header.toString() !== 'BLENDER')
                throw new Error('Blender did not produce a valid .blend header');
        }
        finally {
            await handle.close();
        }
        // Recheck scope after the process returns; never overwrite an existing project.
        signal?.throwIfAborted();
        await scopedPath(root, output, false);
        await fs.copyFile(stagedOutput, output, fs.constants.COPYFILE_EXCL);
        return { success: true, output, version: engine.version, summary };
    }
    finally {
        if (reserved)
            await fs.rm(stagedOutput, { force: true });
        await fs.rm(temp, { recursive: true, force: true });
    }
}
