import path from 'node:path';
import type {
  NativeEngineAction,
  NativeEngineAdapter,
  NativeEngineContext,
  NativeEngineInvocation,
  NativeEngineRequest,
  NativeEngineStep
} from './types.js';

// PDF inspection, page rendering, text extraction, assembly and editing engine for Causyne Agent.
// Headless document renderer, rasterizer, merger, splitter and audit tool.
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
    args.push(step.id);
    if (step.params && Object.keys(step.params).length > 0) {
      for (const [key, val] of Object.entries(step.params)) {
        args.push(`${key}=${typeof val === 'string' ? val : JSON.stringify(val)}`);
      }
    }
  }
  return args;
}

export const pdfEngine: NativeEngineAdapter = {
  id: 'pdf',
  label: 'Causyne PDF Engine',
  envVar: 'CAUSYNE_ENGINE_PDF',
  binaryName: 'causyne-engine-pdf',
  actions: ['catalog', 'describe', 'inspect', 'execute', 'batch', 'export', 'render', 'probe'],
  invoke(request: NativeEngineRequest, context: NativeEngineContext): NativeEngineInvocation {
    let args: string[];
    let artifacts: string[] = [];

    switch (request.action) {
      case 'status':
        args = ['--help'];
        break;
      case 'catalog':
        args = ['tools'];
        break;
      case 'describe':
        args = ['tools'];
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

        args = ['run', ...commandArgs(steps)];

        if (context.saveAs) {
          args.push('--out', context.saveAs);
          artifacts.push(context.saveAs);
        } else if (context.save && context.project) {
          args.push('--out', context.project);
          artifacts.push(context.project);
        }
        break;
      }
      case 'render': {
        const output = request.output ?? '';
        const page = request.start ?? (typeof request.params?.page === 'number' ? request.params.page : 1);
        args = ['render', requireProject(context, 'render'), '--page', String(page), '--out', positional(output)];
        const dpi = request.quality ?? (typeof request.params?.dpi === 'number' ? request.params.dpi : undefined);
        if (dpi) {
          args.push('--dpi', String(dpi));
        }
        artifacts = [output];
        break;
      }
      case 'export': {
        const output = request.output ?? '';
        args = ['extract', requireProject(context, 'export'), '--out', positional(output)];
        const pages = typeof request.params?.pages === 'string' ? request.params.pages : Array.isArray(request.params?.pages) ? request.params.pages.join(',') : undefined;
        if (pages) {
          args.push('--pages', String(pages));
        }
        artifacts = [output];
        break;
      }
      default:
        throw new Error(`Unsupported pdf engine action: ${request.action}`);
    }

    return {
      args,
      artifacts,
      timeoutMs: TIMEOUTS[request.action] ?? 60_000
    };
  }
};
