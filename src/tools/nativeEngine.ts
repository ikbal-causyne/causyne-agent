import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  NATIVE_ENGINES,
  engineInstallDir,
  findEngineBinary,
  engineVersion,
  nativeEngine,
  runEngineBinary
} from '../engines/registry.js';
import { defaultEngineManifestUrl, installNativeEngine } from '../engines/installer.js';
import type {
  NativeEngineAction,
  NativeEngineAdapter,
  NativeEngineContext,
  NativeEngineRequest,
  NativeEngineStep
} from '../engines/types.js';

const ACTIONS: readonly NativeEngineAction[] = [
  'status', 'catalog', 'describe', 'inspect', 'execute', 'batch', 'export', 'render', 'probe', 'install'
];
const PATH_KEYS = new Set([
  'path', 'paths', 'file', 'files', 'input', 'source', 'destination', 'media',
  'directory', 'dir', 'output', 'outputPath', 'out', 'outputFile'
]);
const OUTPUT_KEYS = new Set(['output', 'outputPath', 'out', 'outputFile']);

type ToolContext = {
  signal?: AbortSignal;
  workspacePaths?: string[];
};

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, name: string, max = 4096): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || value.includes('\0') || /[\x00-\x1f]/.test(value)) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

function optionalText(value: unknown, name: string, max = 4096): string | undefined {
  if (value === undefined) return undefined;
  return text(value, name, max);
}

function boolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean`);
  return value;
}

function number(value: unknown, name: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function nearestExisting(target: string): string {
  let current = target;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

function resolveExisting(root: string, value: string, name: string): string {
  const target = path.resolve(root, value);
  if (!fs.existsSync(target)) throw new Error(`${name} does not exist: ${value}`);
  if (!fs.statSync(target).isFile()) throw new Error(`${name} must be a file`);
  const actual = fs.realpathSync(target);
  if (!inside(root, actual)) throw new Error(`${name} must stay inside the workspace`);
  return actual;
}

function resolveNew(root: string, value: string, name: string): string {
  const target = path.resolve(root, value);
  try {
    fs.lstatSync(target);
    throw new Error(`${name} already exists; select a new path`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const existing = nearestExisting(path.dirname(target));
  const actualBase = fs.realpathSync(existing);
  const actual = path.join(actualBase, path.relative(existing, target));
  if (!inside(root, actual)) throw new Error(`${name} must stay inside the workspace`);
  return actual;
}

function resolveForParams(root: string, value: string, name: string, isOutput: boolean): string {
  const target = path.resolve(root, value);
  const existing = nearestExisting(target);
  const actualBase = fs.realpathSync(existing);
  const actual = path.join(actualBase, path.relative(existing, target));
  if (!inside(root, actual)) throw new Error(`${name} must stay inside the workspace`);
  if (isOutput && fs.existsSync(actual)) throw new Error(`${name} already exists; select a new path`);
  return actual;
}

function validateParamPaths(value: unknown, root: string, key: string, depth: number, seen: { count: number }): void {
  if (depth > 8) throw new Error('Engine parameters are nested too deeply');
  if (++seen.count > 2000) throw new Error('Engine parameters are too large');
  if (typeof value === 'string') {
    if (!PATH_KEYS.has(key)) return;
    if (!value.trim() || value.includes('\0')) throw new Error(`Invalid ${key}`);
    resolveForParams(root, value, key, OUTPUT_KEYS.has(key));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) validateParamPaths(item, root, key, depth + 1, seen);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [childKey, child] of Object.entries(value)) {
      validateParamPaths(child, root, childKey, depth + 1, seen);
    }
  }
}

function workspaceFrom(context: ToolContext): string {
  const candidate = context.workspacePaths?.find((item): item is string => typeof item === 'string' && item.trim().length > 0);
  return fs.realpathSync(path.resolve(candidate || process.cwd()));
}

function normalizeSteps(value: unknown): NativeEngineStep[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > 128) {
    throw new Error('steps must contain 1..128 commands');
  }
  return value.map((raw, index) => {
    const step = object(raw, `steps[${index}]`);
    const id = text(step.id, `steps[${index}].id`, 200);
    const params = step.params === undefined ? undefined : object(step.params, `steps[${index}].params`);
    return params ? { id, params } : { id };
  });
}

function parseRequest(value: unknown): NativeEngineRequest {
  const raw = object(value, 'Native engine arguments');
  const action = text(raw.action, 'action', 40) as NativeEngineAction;
  if (!ACTIONS.includes(action)) throw new Error(`Unknown native engine action: ${action}`);
  const engine = optionalText(raw.engine, 'engine', 64) ?? 'film';
  if (!/^[a-z][a-z0-9-]*$/.test(engine)) throw new Error('Invalid engine id');

  const request: NativeEngineRequest = { engine, action };
  const command = optionalText(raw.command, 'command', 200);
  if (command !== undefined) request.command = command;
  if (raw.params !== undefined) request.params = object(raw.params, 'params');
  const steps = normalizeSteps(raw.steps);
  if (steps !== undefined) request.steps = steps;
  const project = optionalText(raw.project, 'project');
  if (project !== undefined) request.project = project;
  const saveAs = optionalText(raw.saveAs, 'saveAs');
  if (saveAs !== undefined) request.saveAs = saveAs;
  const save = boolean(raw.save, 'save');
  if (save !== undefined) request.save = save;
  const demo = boolean(raw.demo, 'demo');
  if (demo !== undefined) request.demo = demo;
  const output = optionalText(raw.output, 'output');
  if (output !== undefined) request.output = output;
  const preset = optionalText(raw.preset, 'preset', 200);
  if (preset !== undefined) request.preset = preset;
  const format = optionalText(raw.format, 'format', 40);
  if (format !== undefined) request.format = format;
  const seconds = number(raw.seconds, 'seconds', 0, 86400);
  if (seconds !== undefined) request.seconds = seconds;
  const scale = number(raw.scale, 'scale', 0.01, 4);
  if (scale !== undefined) request.scale = scale;
  const quality = number(raw.quality, 'quality', 0, 100);
  if (quality !== undefined) request.quality = quality;
  const range = optionalText(raw.range, 'range', 20);
  if (range !== undefined) request.range = range;
  const start = number(raw.start, 'start', 0, 86400);
  if (start !== undefined) request.start = start;
  const end = number(raw.end, 'end', 0, 86400);
  if (end !== undefined) request.end = end;
  const allowOffline = boolean(raw.allowOffline, 'allowOffline');
  if (allowOffline !== undefined) request.allowOffline = allowOffline;
  const keepGoing = boolean(raw.keepGoing, 'keepGoing');
  if (keepGoing !== undefined) request.keepGoing = keepGoing;
  const query = optionalText(raw.query, 'query');
  if (query !== undefined) request.query = query;
  const open = boolean(raw.open, 'open');
  if (open !== undefined) request.open = open;
  const confirm = boolean(raw.confirm, 'confirm');
  if (confirm !== undefined) request.confirm = confirm;
  return request;
}

function validateRequest(request: NativeEngineRequest, workspace: string): NativeEngineContext {
  const project = request.project ? resolveExisting(workspace, request.project, 'project') : undefined;
  const saveAs = request.saveAs ? resolveNew(workspace, request.saveAs, 'saveAs') : undefined;
  if (saveAs) fs.mkdirSync(path.dirname(saveAs), { recursive: true, mode: 0o700 });
  if (request.demo && project) throw new Error('demo and project cannot be combined');
  if (request.save && !project) throw new Error('save requires an existing project');
  if (request.save && saveAs) throw new Error('save and saveAs cannot be combined');
  if (request.output && (request.action === 'export' || request.action === 'render')) {
    const output = resolveNew(workspace, request.output, 'output');
    fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  }
  if (request.action === 'execute' && !request.command) throw new Error('execute requires command');
  if (request.action === 'describe' && !request.command) throw new Error('describe requires command');
  if (request.action === 'batch' && !request.steps?.length) throw new Error('batch requires steps');
  if (request.action === 'export' && !request.output) throw new Error('export requires output');
  if (request.action === 'render' && !request.output) throw new Error('render requires output');
  if (request.action === 'inspect' && request.query && !['all', 'project', 'sequence'].includes(request.query)) {
    throw new Error('inspect query must be all, project, or sequence');
  }
  if (request.action === 'probe') {
    if (!request.query) throw new Error('probe requires query (media path)');
    resolveExisting(workspace, request.query, 'media');
  }
  if (request.range && !['entire', 'inOut', 'workArea', 'custom'].includes(request.range)) {
    throw new Error('range must be entire, inOut, workArea, or custom');
  }
  if (request.params) validateParamPaths(request.params, workspace, 'params', 0, { count: 0 });
  if (request.steps) {
    for (const step of request.steps) {
      if (step.params) validateParamPaths(step.params, workspace, 'params', 0, { count: 0 });
    }
  }
  return {
    workspace,
    ...(project === undefined ? {} : { project }),
    ...(saveAs === undefined ? {} : { saveAs }),
    save: request.save === true,
    demo: request.demo === true,
    keepGoing: request.keepGoing === true
  };
}

function relativeArtifact(workspace: string, file: string): string {
  const relative = path.relative(workspace, file);
  return (relative || path.basename(file)).split(path.sep).join('/');
}

function clean(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '').trim();
}

function parseOutput(action: NativeEngineAction, stdout: string): { data?: unknown; lines?: unknown[]; output?: string } {
  const raw = clean(stdout);
  if (!raw) return {};
  if (action === 'batch') {
    const lines = raw.split(/\r?\n/).filter(Boolean).map(line => {
      try { return JSON.parse(line); } catch { return line; }
    });
    return { lines };
  }
  try {
    return { data: JSON.parse(raw) };
  } catch {
    return { output: raw };
  }
}

function reveal(file: string): Promise<boolean> {
  return new Promise(resolve => {
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd.exe' : 'xdg-open';
    const args = process.platform === 'win32' ? ['/c', 'start', '', file] : [file];
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.once('error', () => resolve(false));
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}

async function engineStatus(workspace: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const engines = [];
  for (const adapter of Object.values(NATIVE_ENGINES)) {
    const binary = findEngineBinary(adapter);
    let version: string | null = null;
    if (binary) {
      try { version = await engineVersion(binary, workspace, signal); } catch { version = null; }
    }
    engines.push({
      id: adapter.id,
      label: adapter.label,
      installed: Boolean(binary),
      version,
      ...(binary ? { binary } : { envVar: adapter.envVar, installDir: engineInstallDir(adapter), installAction: 'install', requiresConsent: true })
    });
  }
  return { success: true, manifestUrl: defaultEngineManifestUrl(), engines };
}

export const nativeEngineTool = {
  schema: {
    name: 'native_engine',
    description: 'Run an installed headless native engine directly. No MCP, no GUI automation, no screenshots. Start with status, then catalog. Use execute or batch with command ids from catalog; project/saveAs scope the document. export and render return artifact paths for immediate GUI/TUI preview. probe inspects media. If the engine is missing, install only after explicit user consent; install never downloads silently. Set open=true only when the user wants the artifact revealed in the OS.',
    parameters: {
      type: 'object',
      properties: {
        engine: { type: 'string', default: 'film', description: 'Engine id, default film. status lists installed engines.' },
        action: { type: 'string', enum: [...ACTIONS] },
        command: { type: 'string', description: 'Command id for execute or describe.' },
        params: { type: 'object', description: 'Command parameters for execute.' },
        steps: {
          type: 'array',
          minItems: 1,
          maxItems: 128,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              params: { type: 'object' }
            },
            required: ['id'],
            additionalProperties: false
          },
          description: 'Ordered {id, params} commands for batch.'
        },
        project: { type: 'string', description: 'Existing project file inside the workspace.' },
        saveAs: { type: 'string', description: 'New project file inside the workspace.' },
        save: { type: 'boolean', description: 'Save edits back to project.' },
        demo: { type: 'boolean', description: 'Open the engine demo document.' },
        output: { type: 'string', description: 'New export or render file inside the workspace.' },
        preset: { type: 'string' },
        format: { type: 'string' },
        seconds: { type: 'number', description: 'Render position in seconds.' },
        scale: { type: 'number', description: 'Render scale, default 1.' },
        quality: { type: 'number' },
        range: { type: 'string', enum: ['entire', 'inOut', 'workArea', 'custom'] },
        start: { type: 'number' },
        end: { type: 'number' },
        allowOffline: { type: 'boolean' },
        keepGoing: { type: 'boolean', description: 'Batch continues after a failed command.' },
        query: { type: 'string', description: 'Catalog filter, inspect target, or media path for probe.' },
        open: { type: 'boolean', description: 'Reveal the resulting artifact in the OS after success.' },
        confirm: { type: 'boolean', description: 'Explicit consent to download and install a missing engine. install without confirm only describes the download.' }
      },
      required: ['action'],
      additionalProperties: false
    }
  },
  async execute(value: unknown, context: ToolContext = {}) {
    let request: NativeEngineRequest | null = null;
    try {
      request = parseRequest(value);
      const workspace = workspaceFrom(context);
      if (request.action === 'status') return await engineStatus(workspace, context.signal);

      const adapter: NativeEngineAdapter | null = nativeEngine(request.engine);
      if (!adapter) return { success: false, error: `Unknown engine: ${request.engine}`, available: Object.keys(NATIVE_ENGINES) };
      if (request.action === 'install') {
        return await installNativeEngine(adapter, {
          confirm: request.confirm === true,
          ...(context.signal ? { signal: context.signal } : {})
        });
      }
      if (!adapter.actions.includes(request.action)) {
        return { success: false, error: `${adapter.label} does not support ${request.action}`, actions: adapter.actions };
      }
      const binary = findEngineBinary(adapter);
      if (!binary) {
        return {
          success: false,
          error: `${adapter.label} is not installed`,
          installed: false,
          envVar: adapter.envVar,
          installDir: engineInstallDir(adapter),
          installAction: 'install',
          manifestUrl: defaultEngineManifestUrl(),
          requiresConsent: true
        };
      }
      const loopContext = validateRequest(request, workspace);
      const invocation = adapter.invoke(request, loopContext);
      let run;
      try {
        run = await runEngineBinary(binary, invocation.args, {
          cwd: workspace,
          timeoutMs: invocation.timeoutMs,
          ...(invocation.stdin === undefined ? {} : { stdin: invocation.stdin }),
          ...(context.signal ? { signal: context.signal } : {})
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).name === 'AbortError') throw error;
        return { success: false, error: `Could not start ${adapter.label}: ${error instanceof Error ? error.message : String(error)}` };
      }

      const artifacts = invocation.artifacts
        .map(file => path.resolve(workspace, file))
        .filter(file => {
          try {
            const actual = fs.realpathSync(file);
            return inside(workspace, actual) && fs.statSync(actual).isFile();
          } catch { return false; }
        })
        .map(file => relativeArtifact(workspace, fs.realpathSync(file)));
      let opened = false;
      if (request.open && artifacts.length > 0) {
        opened = await reveal(path.resolve(workspace, artifacts[0]!));
      }
      const parsed = parseOutput(request.action, run.stdout);
      const diagnostics = clean(run.stderr);
      const success = run.exitCode === 0;
      return {
        success,
        engine: adapter.id,
        action: request.action,
        ...(success ? {} : { error: diagnostics.split(/\r?\n/).filter(Boolean).slice(-4).join('\n') || `Engine exited with code ${run.exitCode}`, exitCode: run.exitCode }),
        ...parsed,
        ...(artifacts.length > 0 ? { artifacts } : {}),
        ...(opened ? { opened: true } : {}),
        ...(diagnostics && success ? { diagnostics: diagnostics.slice(-4000) } : {})
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        ...(request ? { engine: request.engine, action: request.action } : {})
      };
    }
  }
};
