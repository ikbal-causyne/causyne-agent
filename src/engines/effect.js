import path from 'node:path';
// Visual effects, motion graphics, compositing, and layer animation engine for Causyne Agent.
// Headless After Effects-class compositor, frame renderer, sequence exporter, and property evaluator.
// Operates deterministically via clean CLI subcommands.
const TIMEOUTS = {
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
function positional(value) {
    return value.startsWith('-') ? `.${path.sep}${value}` : value;
}
function requireProject(context, action) {
    if (!context.project)
        throw new Error(`${action} requires project`);
    return positional(context.project);
}
function commandArgs(steps) {
    const args = [];
    for (const step of steps) {
        args.push(step.id);
        args.push(step.params && Object.keys(step.params).length > 0 ? JSON.stringify(step.params) : '{}');
    }
    return args;
}
export const effectEngine = {
    id: 'effect',
    label: 'Causyne Effect Engine',
    envVar: 'CAUSYNE_ENGINE_EFFECT',
    binaryName: 'causyne-engine-effect',
    actions: ['catalog', 'describe', 'inspect', 'execute', 'batch', 'export', 'render', 'probe'],
    invoke(request, context) {
        let args;
        let artifacts = [];
        switch (request.action) {
            case 'status':
                args = ['info', '--json'];
                break;
            case 'catalog':
                args = ['commands', '--json'];
                break;
            case 'describe':
                args = ['commands', '--json', ...(request.command ? ['--filter', request.command] : [])];
                break;
            case 'inspect': {
                args = ['info', '--json'];
                if (context.project) {
                    args.push('--project', requireProject(context, 'inspect'));
                }
                break;
            }
            case 'probe': {
                args = ['info', '--project', positional(request.query ?? ''), '--json'];
                break;
            }
            case 'execute':
            case 'batch': {
                const steps = request.action === 'execute'
                    ? [{ id: request.command ?? '', ...(request.params ? { params: request.params } : {}) }]
                    : (request.steps ?? []);
                args = ['run', ...commandArgs(steps)];
                if (context.project) {
                    args.push('--project', positional(context.project));
                }
                else if (context.demo) {
                    args.push('--demo');
                }
                if (context.saveAs) {
                    args.push('--save-as', context.saveAs);
                    artifacts.push(context.saveAs);
                }
                else if (context.save && context.project) {
                    args.push('--save');
                    artifacts.push(context.project);
                }
                break;
            }
            case 'render': {
                const output = request.output ?? '';
                args = ['render-frame', '--out', positional(output)];
                if (context.project) {
                    args.push('--project', requireProject(context, 'render'));
                }
                else if (context.demo) {
                    args.push('--demo');
                }
                if (request.seconds !== undefined) {
                    args.push('--time', String(request.seconds));
                }
                if (request.scale) {
                    args.push('--scale', String(request.scale));
                }
                artifacts = [output];
                break;
            }
            case 'export': {
                const output = request.output ?? '';
                args = ['render', '--out', positional(output)];
                if (context.project) {
                    args.push('--project', requireProject(context, 'export'));
                }
                else if (context.demo) {
                    args.push('--demo');
                }
                const fps = request.quality ?? (typeof request.params?.fps === 'number' ? request.params.fps : undefined);
                if (fps) {
                    args.push('--fps', String(fps));
                }
                artifacts = [output];
                break;
            }
            default:
                throw new Error(`Unsupported effect engine action: ${request.action}`);
        }
        return {
            args,
            artifacts,
            timeoutMs: TIMEOUTS[request.action] ?? 60_000
        };
    }
};
