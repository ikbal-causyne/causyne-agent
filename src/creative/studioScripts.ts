import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export type StudioHost =
  | 'photoshop'
  | 'premiere'
  | 'after-effects'
  | 'photo-studio'
  | 'video-studio'
  | 'motion-studio';

type CanonicalHost = 'photoshop' | 'premiere' | 'after-effects';

export function canonicalHost(host: unknown): CanonicalHost {
  if (host === 'photo-studio' || host === 'photoshop') return 'photoshop';
  if (host === 'video-studio' || host === 'premiere') return 'premiere';
  if (host === 'motion-studio' || host === 'after-effects') return 'after-effects';
  throw new Error('Supported studio hosts: photo-studio (or photoshop), video-studio (or premiere), motion-studio (or after-effects)');
}

type Dict = Record<string, unknown>;

function object(value: unknown): Dict {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object');
  return value as Dict;
}

function text(value: unknown, name: string, max = 256): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f]/.test(value)) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

function number(value: unknown, name: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`Invalid ${name}: expected ${min}..${max}`);
  }
  return value;
}

export interface StudioJob {
  host: StudioHost;
  canonicalHost: CanonicalHost;
  input?: string | undefined;
  output: string;
  actions: Dict[];
}

export function validateStudioJob(value: unknown): StudioJob {
  const job = object(value);
  const cHost = canonicalHost(job.host);
  const output = text(job.output, 'output', 4096);

  if (cHost === 'photoshop') {
    if (!/\.(psd|png|jpg|jpeg|webp)$/i.test(output)) {
      throw new Error('Output must be PSD, PNG, JPG, or WEBP for Photo Studio');
    }
  } else if (cHost === 'premiere') {
    if (!/\.(prproj|xml)$/i.test(output)) {
      throw new Error('Output must be PRPROJ or XML for Video Studio');
    }
  } else {
    if (!/\.aep$/i.test(output)) {
      throw new Error('Output must be AEP for Motion Studio');
    }
  }

  const input = (cHost === 'photoshop' || cHost === 'premiere') && job.input !== undefined
    ? text(job.input, 'input', 4096)
    : undefined;

  if (!Array.isArray(job.actions) || job.actions.length < 1 || job.actions.length > 64) {
    throw new Error('Provide 1..64 editing actions');
  }

  const actions = job.actions.map(raw => {
    const a = object(raw);
    const type = text(a.type, 'action type');

    if (cHost === 'photoshop') {
      if (type === 'resize') return { type, width: number(a.width, 'width', 1, 16384), height: number(a.height, 'height', 1, 16384) };
      if (type === 'rotate') return { type, angle: number(a.angle, 'angle', -360, 360) };
      if (type === 'crop') return { type, left: number(a.left ?? 0, 'left', 0, 16384), top: number(a.top ?? 0, 'top', 0, 16384), width: number(a.width, 'width', 1, 16384), height: number(a.height, 'height', 1, 16384) };
      if (type === 'layer') {
        const result: Dict = { type, index: number(a.index, 'layer index', 0, 9999) };
        if (!Number.isInteger(result.index)) throw new Error('Layer index must be an integer');
        if (a.name !== undefined) result.name = text(a.name, 'layer name');
        if (a.opacity !== undefined) result.opacity = number(a.opacity, 'opacity', 0, 100);
        if (a.visible !== undefined) {
          if (typeof a.visible !== 'boolean') throw new Error('visible must be boolean');
          result.visible = a.visible;
        }
        if (a.blendMode !== undefined) result.blendMode = text(a.blendMode, 'blend mode', 64);
        if (Object.keys(result).length === 2) throw new Error('Specify a layer change');
        return result;
      }
      if (type === 'new_layer') return { type, name: text(a.name, 'layer name'), opacity: typeof a.opacity === 'number' ? number(a.opacity, 'opacity', 0, 100) : 100 };
      if (type === 'text') return { type, text: text(a.text, 'text', 4000), x: number(a.x ?? 50, 'x', 0, 16384), y: number(a.y ?? 50, 'y', 0, 16384), size: typeof a.size === 'number' ? number(a.size, 'size', 1, 1000) : 32, font: typeof a.font === 'string' ? text(a.font, 'font') : 'Helvetica' };
      if (type === 'adjust_color') return { type, brightness: typeof a.brightness === 'number' ? number(a.brightness, 'brightness', -100, 100) : 0, contrast: typeof a.contrast === 'number' ? number(a.contrast, 'contrast', -100, 100) : 0 };
      if (type === 'flatten') return { type };
    } else if (cHost === 'premiere') {
      if (type === 'sequence') return { type, name: text(a.name, 'sequence name'), width: typeof a.width === 'number' ? number(a.width, 'width', 16, 8192) : 1920, height: typeof a.height === 'number' ? number(a.height, 'height', 16, 8192) : 1080, fps: typeof a.fps === 'number' ? number(a.fps, 'fps', 1, 120) : 30 };
      if (type === 'import') return { type, path: text(a.path, 'media path', 4096), start: number(a.start ?? 0, 'start', 0, 36000), ...(a.duration === undefined ? {} : { duration: number(a.duration, 'duration', 0.04, 36000) }), track: typeof a.track === 'number' ? number(a.track, 'track', 0, 99) : 0, mediaType: typeof a.mediaType === 'string' ? text(a.mediaType, 'mediaType') : 'video' };
      if (type === 'marker') return { type, start: number(a.start, 'marker time', 0, 36000), ...(a.name !== undefined ? { name: text(a.name, 'marker name') } : {}), ...(a.comment !== undefined ? { comment: text(a.comment, 'marker comment') } : {}) };
      if (type === 'cut') return { type, time: number(a.time, 'cut time', 0, 36000), track: number(a.track ?? 0, 'track index', 0, 99) };
    } else {
      if (type === 'composition') return { type, name: text(a.name, 'composition name'), width: number(a.width, 'width', 4, 16384), height: number(a.height, 'height', 4, 16384), duration: number(a.duration, 'duration', 0.04, 36000), fps: number(a.fps, 'fps', 1, 120) };
      if (type === 'import') return { type, path: text(a.path, 'media path', 4096), start: number(a.start ?? 0, 'start', 0, 36000), ...(a.duration === undefined ? {} : { duration: number(a.duration, 'duration', 0.04, 36000) }) };
      if (type === 'text') return { type, text: text(a.text, 'text', 2000), start: number(a.start ?? 0, 'start', 0, 36000) };
      if (type === 'solid') return { type, name: text(a.name, 'solid name'), width: number(a.width ?? 1920, 'width', 4, 16384), height: number(a.height ?? 1080, 'height', 4, 16384), duration: number(a.duration ?? 10, 'duration', 0.04, 36000) };
    }
    throw new Error('Unsupported editing action for this host');
  });

  if (cHost === 'after-effects' && (actions[0]?.type !== 'composition' || actions.filter(a => a.type === 'composition').length !== 1)) {
    throw new Error('Motion Studio jobs must begin with exactly one composition');
  }

  return { host: job.host as StudioHost, canonicalHost: cHost, input, output, actions };
}

/** Fixed native operations; no model-provided script, eval, network, or service key. */
export function studioScript(value: unknown, resultFile: string): string {
  const job = validateStudioJob(value);
  const cHost = job.canonicalHost;
  const data = JSON.stringify({ ...job, resultFile }).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  const common = `var job = ${data};\nvar output = new File(job.output);\nif (output.exists) throw new Error('Output already exists');\n`;

  const photoshop = `var source = null, edited = null;
var previousDialogs = app.displayDialogs;
try {
  app.displayDialogs = DialogModes.NO;
  if (job.input) {
    source = app.open(new File(job.input));
    edited = source.duplicate('Causyne Studio Edit', false);
  } else {
    edited = app.documents.add(1920, 1080, 72, 'Causyne Studio Project', NewDocumentMode.RGB);
  }
  for (var i=0; i<job.actions.length; i++) {
    var a=job.actions[i];
    if (a.type==='resize') edited.resizeImage(UnitValue(a.width,'px'),UnitValue(a.height,'px'),null,ResampleMethod.BICUBIC);
    else if (a.type==='rotate') edited.rotateCanvas(a.angle);
    else if (a.type==='crop') edited.crop([UnitValue(a.left,'px'),UnitValue(a.top,'px'),UnitValue(a.left+a.width,'px'),UnitValue(a.top+a.height,'px')]);
    else if (a.type==='flatten') edited.flatten();
    else if (a.type==='new_layer') {
      var nl = edited.artLayers.add();
      nl.name = a.name;
      if (a.opacity !== undefined) nl.opacity = a.opacity;
    } else if (a.type==='text') {
      var tl = edited.artLayers.add();
      tl.kind = LayerKind.TEXT;
      tl.textItem.contents = a.text;
      tl.textItem.position = [UnitValue(a.x,'px'), UnitValue(a.y,'px')];
      if (a.size) tl.textItem.size = UnitValue(a.size,'pt');
    } else if (a.type==='adjust_color') {
      if (edited.activeLayer) {
        if (a.brightness !== 0 || a.contrast !== 0) {
          try { edited.activeLayer.adjustBrightnessContrast(a.brightness, a.contrast); } catch(e){}
        }
      }
    } else {
      if (a.index>=edited.layers.length) throw new Error('Layer index does not exist');
      var layer=edited.layers[a.index];
      if (a.name!==undefined) layer.name=a.name;
      if (a.opacity!==undefined) layer.opacity=a.opacity;
      if (a.visible!==undefined) layer.visible=a.visible;
    }
  }
  if (output.exists) throw new Error('Output appeared while editing; refusing overwrite');
  var options = /\\.png$/i.test(job.output) ? new PNGSaveOptions()
    : /\\.(jpe?g)$/i.test(job.output) ? new JPEGSaveOptions()
    : new PhotoshopSaveOptions();
  edited.saveAs(output, options, true, Extension.LOWERCASE);
} finally {
  if (edited) edited.close(SaveOptions.DONOTSAVECHANGES);
  if (source) source.close(SaveOptions.DONOTSAVECHANGES);
  app.displayDialogs=previousDialogs;
}
`;

  const premiere = `// Video Studio batch automation
var proj = null;
if (job.input) {
  app.openDocument(new File(job.input).fsName, false, false, false);
}
if (!app.project) {
  app.newProject(new File(job.output).fsName);
}
proj = app.project;
if (!proj) throw new Error('Could not access Video Studio project');
for (var i = 0; i < job.actions.length; i++) {
  var a = job.actions[i];
  if (a.type === 'sequence') {
    proj.createNewSequence(a.name, '');
  } else if (a.type === 'import') {
    var fileObj = new File(a.path);
    if (!fileObj.exists) throw new Error('Import file does not exist: ' + a.path);
    proj.importFiles([fileObj.fsName], true, proj.rootItem, false);
    if (proj.activeSequence && proj.rootItem.children.numItems > 0) {
      var item = proj.rootItem.children[proj.rootItem.children.numItems - 1];
      if (item && proj.activeSequence.videoTracks && proj.activeSequence.videoTracks.numTracks > 0) {
        proj.activeSequence.videoTracks[a.track || 0].insertClip(item, a.start || 0);
      }
    }
  } else if (a.type === 'marker') {
    if (proj.activeSequence && proj.activeSequence.markers) {
      var m = proj.activeSequence.markers.createMarker(a.start);
      if (a.name) m.name = a.name;
      if (a.comment) m.comments = a.comment;
    }
  }
}
if (output.exists) throw new Error('Output appeared while editing; refusing overwrite');
proj.saveAs(output.fsName);
`;

  const afterEffects = `// Motion Studio batch automation
if (app.project && (app.project.file || app.project.numItems>0)) throw new Error('Open an empty project before running this batch');
if (!app.project) app.newProject();
app.beginUndoGroup('Causyne creative batch');
try {
  var c=job.actions[0];
  var comp=app.project.items.addComp(c.name,c.width,c.height,1,c.duration,c.fps);
  for (var i=1; i<job.actions.length; i++) {
    var a=job.actions[i], layer;
    if (a.type==='import') {
      var media=app.project.importFile(new ImportOptions(new File(a.path)));
      layer=comp.layers.add(media); layer.startTime=a.start;
      if (a.duration!==undefined) layer.outPoint=Math.min(a.start+a.duration,comp.duration);
    } else if (a.type==='solid') {
      layer=comp.layers.addSolid([0.1,0.1,0.1],a.name,a.width||comp.width,a.height||comp.height,1,a.duration||comp.duration);
    } else {
      layer=comp.layers.addText(a.text); layer.startTime=a.start;
    }
  }
  if (output.exists) throw new Error('Output appeared while editing; refusing overwrite');
  app.project.save(output);
} finally { app.endUndoGroup(); }
`;

  const body = cHost === 'photoshop' ? photoshop : cHost === 'premiere' ? premiere : afterEffects;
  return `// Causyne Agent: reviewed local creative editing batch.\n(function(){\n${common}${body}
if (!output.exists || output.length===0) throw new Error('The host did not save the requested output');
var result = new File(job.resultFile);
result.encoding='UTF-8';
if (!result.open('w')) throw new Error('Cannot write completion receipt');
result.write('CAUSYNE_EDIT_COMPLETE'); result.close();
})();\n`;
}

function isInside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function scoped(root: string, value: string, exists: boolean): Promise<string> {
  const file = path.resolve(root, value);
  const actual = exists
    ? await fs.realpath(file)
    : path.join(await fs.realpath(path.dirname(file)), path.basename(file));
  if (!isInside(root, actual)) throw new Error('Editing files must remain in the selected workspace');
  if (!exists) {
    try {
      await fs.lstat(file);
      throw new Error('Output already exists');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  return actual;
}

export async function findHostApplication(host: CanonicalHost): Promise<string | null> {
  if (process.platform === 'darwin') {
    const pattern = host === 'photoshop'
      ? /(?:^|\s)Photoshop(?:\s|\.app)/i
      : host === 'premiere'
      ? /(?:^|\s)Premiere(?:\s+Pro)?(?:\s|\.app)/i
      : /(?:^|\s)After\s+Effects(?:\s|\.app)/i;

    for (const root of ['/Applications', path.join(os.homedir(), 'Applications')]) {
      let entries: string[];
      try { entries = await fs.readdir(root); } catch { continue; }
      for (const name of entries.filter(n => pattern.test(n)).sort().reverse()) {
        if (name.endsWith('.app')) return path.join(root, name);
        const parent = path.join(root, name);
        try {
          const bundle = (await fs.readdir(parent)).find(n => pattern.test(n) && n.endsWith('.app'));
          if (bundle) return path.join(parent, bundle);
        } catch { /* Not an application folder. */ }
      }
    }
    return null;
  }

  if (process.platform === 'win32') {
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const folderPattern = host === 'photoshop' ? /Photoshop/i : host === 'premiere' ? /Premiere/i : /After Effects/i;
    const exePattern = host === 'photoshop' ? /Photoshop\.exe$/i : host === 'premiere' ? /Premiere\.exe$/i : /AfterFX\.exe$/i;
    try {
      const topDirs = await fs.readdir(programFiles);
      for (const dir of topDirs) {
        const fullDir = path.join(programFiles, dir);
        if (folderPattern.test(dir)) {
          const files = await fs.readdir(fullDir);
          const foundExe = files.find(f => exePattern.test(f));
          if (foundExe) return path.join(fullDir, foundExe);
        }
      }
    } catch { /* Ignore filesystem search failures */ }
  }

  return null;
}

export async function runStudioEdit(value: unknown, workspace = process.cwd(), signal?: AbortSignal) {
  signal?.throwIfAborted();
  const job = validateStudioJob(value);
  const root = await fs.realpath(workspace);
  job.output = await scoped(root, job.output, false);
  if (job.input) job.input = await scoped(root, job.input, true);
  for (const action of job.actions) {
    if (action.type === 'import') action.path = await scoped(root, String(action.path), true);
  }

  const application = await findHostApplication(job.canonicalHost);
  if (!application) {
    return {
      success: false,
      error: `Creative host (${job.host}) is not installed at a supported location. No editing was attempted.`
    };
  }

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'causyne-studio-'));
  try {
    const scriptFile = path.join(dir, 'edit.jsx');
    const receipt = path.join(dir, `${randomUUID()}.receipt`);
    await fs.writeFile(scriptFile, studioScript(job, receipt), { mode: 0o600 });

    if (process.platform === 'darwin') {
      const quote = (s: string) => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
      const invocation = job.canonicalHost === 'photoshop'
        ? `do javascript file (POSIX file ${quote(scriptFile)})`
        : job.canonicalHost === 'premiere'
        ? `try\n  do javascript file (POSIX file ${quote(scriptFile)})\non error\n  try\n    DoScriptFile (POSIX file ${quote(scriptFile)})\n  on error\n    open (POSIX file ${quote(scriptFile)})\n  end try\nend try`
        : `DoScriptFile (POSIX file ${quote(scriptFile)})`;

      await exec('/usr/bin/osascript', ['-e', `with timeout of 120 seconds\ntell application ${quote(application)}\n${invocation}\nend tell\nend timeout`], {
        cwd: root, timeout: 125000, maxBuffer: 128 * 1024, ...(signal ? { signal } : {}), env: { PATH: '/usr/bin:/bin', HOME: os.homedir() }
      });
    } else {
      // Windows COM / Command invocation
      await exec(application, ['-r', scriptFile], {
        cwd: root, timeout: 125000, maxBuffer: 128 * 1024, ...(signal ? { signal } : {})
      });
    }

    signal?.throwIfAborted();
    if ((await fs.readFile(receipt, 'utf8')) !== 'CAUSYNE_EDIT_COMPLETE') {
      throw new Error('No completion receipt from the creative host');
    }
    const output = await scoped(root, job.output, true);
    const stat = await fs.stat(output);
    if (!stat.isFile() || !stat.size) {
      throw new Error('The creative host did not produce a nonempty output file');
    }
    return { success: true, output, bytes: stat.size, host: job.host };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
