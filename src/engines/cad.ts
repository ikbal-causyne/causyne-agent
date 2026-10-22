import path from 'node:path';
import type {
  NativeEngineAction,
  NativeEngineAdapter,
  NativeEngineContext,
  NativeEngineInvocation,
  NativeEngineRequest,
  NativeEngineStep
} from './types.js';

// CAD engine for Causyne Agent (headless 2D/3D CAD editing, conversion, and export).
// Speaks DXF, DWG, SVG, PNG, PDF. Operates deterministically via clean CLI subcommands.

const TIMEOUTS: Record<NativeEngineAction, number> = {
  status: 10_000,
  catalog: 30_000,
  describe: 30_000,
  inspect: 60_000,
  execute: 180_000,
  batch: 600_000,
  export: 300_000,
  render: 300_000,
  probe: 60_000,
  install: 600_000
};

function positional(value: string): string {
  return value.startsWith('-') ? `.${path.sep}${value}` : value;
}

function requireProject(context: NativeEngineContext, action: string): string {
  if (!context.project) throw new Error(`${action} requires project`);
  return positional(context.project);
}

function commandArgs(steps: NativeEngineStep[]): string[] {
  const args: string[] = [];
  for (const step of steps) {
    if (step.params && Object.keys(step.params).length > 0) {
      args.push('--cmd', `${step.id} ${JSON.stringify(step.params)}`);
    } else {
      args.push('--cmd', step.id);
    }
  }
  return args;
}

export const cadEngine: NativeEngineAdapter = {
  id: 'cad',
  label: 'Causyne CAD Engine',
  envVar: 'CAUSYNE_ENGINE_CAD',
  binaryName: 'causyne-engine-cad',
  actions: ['catalog', 'describe', 'inspect', 'execute', 'batch', 'export', 'render', 'probe'],
  invoke(request: NativeEngineRequest, context: NativeEngineContext): NativeEngineInvocation {
    let args: string[];
    let artifacts: string[] = [];

    switch (request.action) {
      case 'status':
        args = ['--version'];
        break;
      case 'catalog':
        args = ['commands', ...(request.query ? [request.query] : [])];
        break;
      case 'describe':
        args = ['commands', request.command ?? ''];
        break;
      case 'inspect':
        args = ['info', requireProject(context, 'inspect')];
        break;
      case 'probe':
        args = ['info', positional(request.query ?? '')];
        break;
      case 'execute':
      case 'batch': {
        const steps: NativeEngineStep[] = request.action === 'execute'
          ? [{ id: request.command ?? '', ...(request.params ? { params: request.params } : {}) }]
          : (request.steps ?? []);

        args = ['run'];
        if (context.project) {
          args.push(positional(context.project));
        } else if (context.demo) {
          args.push('--sample');
        }

        args.push(...commandArgs(steps));

        if (context.saveAs) {
          args.push('--save', context.saveAs);
          artifacts.push(context.saveAs);
        } else if (context.save && context.project) {
          args.push('--save', context.project);
          artifacts.push(context.project);
        }

        if (request.output) {
          args.push('--export', request.output);
          artifacts.push(request.output);
        }
        break;
      }
      case 'export': {
        const output = request.output ?? '';
        args = ['convert', requireProject(context, 'export'), positional(output)];
        artifacts = [output];
        break;
      }
      case 'render': {
        // Render 2D/3D view directly to PNG, SVG, or PDF
        const output = request.output ?? '';
        args = ['run'];
        if (context.project) {
          args.push(positional(context.project));
        } else if (context.demo) {
          args.push('--sample');
        }
        args.push('--export', positional(output));
        artifacts = [output];
        break;
      }
      default:
        throw new Error(`Unsupported CAD engine action: ${request.action}`);
    }

    return { args, artifacts: artifacts.filter(Boolean), timeoutMs: TIMEOUTS[request.action] };
  }
};
