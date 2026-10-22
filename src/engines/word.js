import path from 'node:path';
// Document typesetting, DOCX/PDF formatting, and text processing engine for Causyne Agent.
// Headless word processor, document structural inspector, and batch runner.
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
        if (step.params && Object.keys(step.params).length > 0) {
            args.push('--cmd', `${step.id}=${JSON.stringify(step.params)}`);
        }
        else {
            args.push('--cmd', step.id);
        }
    }
    return args;
}
export const wordEngine = {
    id: 'word',
    label: 'Causyne Word Engine',
    envVar: 'CAUSYNE_ENGINE_WORD',
    binaryName: 'causyne-engine-word',
    actions: ['catalog', 'describe', 'inspect', 'execute', 'batch', 'export', 'render', 'probe'],
    invoke(request, context) {
        let args;
        let artifacts = [];
        switch (request.action) {
            case 'status':
                args = ['--version'];
                break;
            case 'catalog':
                args = ['commands', '--json'];
                break;
            case 'describe':
                args = ['commands', '--json'];
                break;
            case 'inspect':
                args = ['info', requireProject(context, 'inspect')];
                break;
            case 'probe':
                args = ['info', positional(request.query ?? '')];
                break;
            case 'execute':
            case 'batch': {
                const steps = request.action === 'execute'
                    ? [{ id: request.command ?? '', ...(request.params ? { params: request.params } : {}) }]
                    : (request.steps ?? []);
                args = ['run'];
                if (context.project) {
                    args.push('--file', positional(context.project));
                }
                else if (context.demo) {
                    args.push('--template', 'blank');
                }
                args.push(...commandArgs(steps));
                if (context.saveAs) {
                    args.push('--save', context.saveAs);
                    artifacts.push(context.saveAs);
                }
                else if (context.save && context.project) {
                    args.push('--save', context.project);
                    artifacts.push(context.project);
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
                const output = request.output ?? '';
                args = ['render', requireProject(context, 'render'), positional(output)];
                if (request.range) {
                    args.push('--page', request.range);
                }
                if (request.scale !== undefined) {
                    args.push('--scale', String(request.scale));
                }
                artifacts = [output];
                break;
            }
            default:
                throw new Error(`Unsupported word engine action: ${request.action}`);
        }
        return {
            args,
            artifacts,
            timeoutMs: TIMEOUTS[request.action] ?? 60_000
        };
    }
};
