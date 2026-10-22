import path from 'node:path';
import type {
  NativeEngineAction,
  NativeEngineAdapter,
  NativeEngineContext,
  NativeEngineInvocation,
  NativeEngineRequest,
  NativeEngineStep
} from './types.js';

// Multi-page layout, vector illustration, and publication engine for Causyne Agent.
// Headless document composer, IDML/ePub/PDF/SVG/PNG renderer, and batch pipeline.
// Operates deterministically via clean CLI subcommands.

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
      args.push('--cmd', `${step.id}=${JSON.stringify(step.params)}`);
    } else {
      args.push('--cmd', step.id);
    }
  }
  return args;
}

export const designEngine: NativeEngineAdapter = {
  id: 'design',
  label: 'Causyne Design Engine',
  envVar: 'CAUSYNE_ENGINE_DESIGN',
  binaryName: 'causyne-engine-design',
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
        args = ['describe', request.command ?? ''];
        break;
      case 'inspect':
      case 'probe': {
        const file = request.action === 'inspect' ? requireProject(context, 'inspect') : positional(request.query ?? '');
        args = ['run', '--in', file, '--export', '/dev/null'];
        break;
      }
      case 'execute':
      case 'batch': {
        const steps: NativeEngineStep[] = request.action === 'execute'
          ? [{ id: request.command ?? '', ...(request.params ? { params: request.params } : {}) }]
          : (request.steps ?? []);

        args = ['run'];
        if (context.project) {
          args.push('--in', positional(context.project));
        } else if (context.demo) {
          args.push('--sample');
        }

        args.push(...commandArgs(steps));

        if (context.saveAs) {
          args.push('--export', context.saveAs);
          artifacts.push(context.saveAs);
        } else if (context.save && context.project) {
          args.push('--export', context.project);
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
        args = ['run', '--in', requireProject(context, 'export'), '--export', positional(output)];
        artifacts = [output];
        break;
      }
      case 'render': {
        const output = request.output ?? '';
        args = ['run'];
        if (context.project) {
          args.push('--in', positional(context.project));
        } else {
          args.push('--sample');
        }

        if (request.range) {
          args.push('--page', request.range);
        }

        if (request.scale !== undefined) {
          args.push('--scale', String(request.scale));
        }

        args.push('--export', positional(output));
        artifacts = [output];
        break;
      }
      default:
        throw new Error(`Unsupported design engine action: ${request.action}`);
    }

    return {
      args,
      artifacts,
      timeoutMs: TIMEOUTS[request.action] ?? 60_000
    };
  }
};
