import path from 'node:path';
import type {
  NativeEngineAction,
  NativeEngineAdapter,
  NativeEngineContext,
  NativeEngineInvocation,
  NativeEngineRequest,
  NativeEngineStep
} from './types.js';

// Raster image engine. The binary speaks a verb-per-subcommand CLI and
// rejects any flag a subcommand does not declare, so every argument list here
// is built per verb. Nothing is appended globally.

const TIMEOUTS: Record<NativeEngineAction, number> = {
  status: 10_000,
  catalog: 30_000,
  describe: 30_000,
  inspect: 60_000,
  execute: 180_000,
  batch: 600_000,
  export: 300_000,
  render: 120_000,
  probe: 60_000,
  install: 600_000
};

const NEW_DOCUMENT = 'file.new';

function positional(value: string): string {
  // A positional that begins with "-" would be parsed as a flag.
  return value.startsWith('-') ? `.${path.sep}${value}` : value;
}

function quality(value: number | undefined): string[] {
  if (value === undefined) return [];
  return ['--quality', String(Math.min(100, Math.max(1, Math.round(value))))];
}

function commandArgs(steps: NativeEngineStep[]): string[] {
  const args: string[] = [];
  for (const step of steps) {
    args.push('--cmd', step.id);
    if (step.params && Object.keys(step.params).length > 0) args.push('--params', JSON.stringify(step.params));
  }
  return args;
}

/**
 * Source for `run`: the existing project, or a new document when the first
 * step is file.new. Returns the remaining steps to apply.
 */
function runSource(steps: NativeEngineStep[], context: NativeEngineContext): { args: string[]; rest: NativeEngineStep[] } {
  if (context.project) return { args: [positional(context.project)], rest: steps };
  const [first, ...rest] = steps;
  if (first?.id === NEW_DOCUMENT) {
    return { args: ['--new', JSON.stringify(first.params ?? { width: 1920, height: 1080 })], rest };
  }
  throw new Error(`The photo engine needs project, or a first step of ${NEW_DOCUMENT} to create a document`);
}

function destination(context: NativeEngineContext): { args: string[]; artifact?: string } {
  if (context.saveAs) return { args: ['--out', context.saveAs], artifact: context.saveAs };
  if (context.save && context.project) return { args: ['--out', context.project], artifact: context.project };
  return { args: [] };
}

function requireProject(context: NativeEngineContext, action: string): string {
  if (!context.project) throw new Error(`${action} requires project`);
  return positional(context.project);
}

export const photoEngine: NativeEngineAdapter = {
  id: 'photo',
  label: 'Causyne Photo Engine',
  envVar: 'CAUSYNE_ENGINE_PHOTO',
  binaryName: 'causyne-engine-photo',
  actions: ['catalog', 'describe', 'inspect', 'execute', 'batch', 'export', 'render', 'probe'],
  invoke(request: NativeEngineRequest, context: NativeEngineContext): NativeEngineInvocation {
    if (context.demo) throw new Error('The photo engine has no demo document; use a first step of file.new');
    let args: string[];
    let artifacts: string[] = [];

    switch (request.action) {
      case 'status':
        args = ['--version'];
        break;
      case 'catalog':
        args = ['commands', '--json', ...(request.query ? ['--filter', request.query] : [])];
        break;
      case 'describe':
        args = ['commands', '--json', '--filter', request.command ?? ''];
        break;
      case 'inspect':
        args = ['info', requireProject(context, 'inspect'), '--compact'];
        break;
      case 'probe':
        args = ['info', positional(request.query ?? ''), '--compact'];
        break;
      case 'execute':
      case 'batch': {
        if (context.keepGoing) throw new Error('The photo engine stops at the first failed step; keepGoing is not supported');
        const steps: NativeEngineStep[] = request.action === 'execute'
          ? [{ id: request.command ?? '', ...(request.params ? { params: request.params } : {}) }]
          : (request.steps ?? []);
        const source = runSource(steps, context);
        const out = destination(context);
        if (source.rest.length === 0 && out.args.length === 0) {
          throw new Error('Nothing to do: add a command after file.new, or saveAs to write the new document');
        }
        args = ['run', ...source.args, ...commandArgs(source.rest), ...out.args];
        if (out.artifact) artifacts = [out.artifact];
        break;
      }
      case 'export': {
        const output = request.output ?? '';
        args = ['convert', requireProject(context, 'export'), positional(output),
          ...(request.format ? ['--format', request.format] : []), ...quality(request.quality)];
        artifacts = [output];
        break;
      }
      case 'render': {
        // A flattened preview. Defaults to PNG only when the output has no
        // extension, so the bytes always match the file name.
        const output = request.output ?? '';
        const format = request.format ?? (path.extname(output) ? undefined : 'png');
        args = ['convert', requireProject(context, 'render'), positional(output), ...(format ? ['--format', format] : [])];
        artifacts = [output];
        break;
      }
      default:
        throw new Error(`Unsupported photo engine action: ${request.action}`);
    }

    return { args, artifacts: artifacts.filter(Boolean), timeoutMs: TIMEOUTS[request.action] };
  }
};
