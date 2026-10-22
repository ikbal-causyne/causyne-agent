import path from 'node:path';
// Spreadsheet, workbook calculation, and tabular data engine for Causyne Agent.
// Headless spreadsheet evaluator, XLSX/CSV/TSV/HTML converter, and calculation oracle.
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
export const gridEngine = {
    id: 'grid',
    label: 'Causyne Grid Engine',
    envVar: 'CAUSYNE_ENGINE_GRID',
    binaryName: 'causyne-engine-grid',
    actions: ['catalog', 'describe', 'inspect', 'execute', 'batch', 'export', 'render', 'probe'],
    invoke(request, context) {
        let args;
        let artifacts = [];
        switch (request.action) {
            case 'status':
                args = ['version'];
                break;
            case 'catalog':
                args = ['commands', '--json', ...(request.query ? ['--search', request.query] : [])];
                break;
            case 'describe':
                args = ['commands', '--json', ...(request.command ? ['--search', request.command] : [])];
                break;
            case 'inspect':
                args = ['info', requireProject(context, 'inspect'), '--json'];
                break;
            case 'probe':
                args = ['info', positional(request.query ?? ''), '--json'];
                break;
            case 'execute':
            case 'batch': {
                const steps = request.action === 'execute'
                    ? [{ id: request.command ?? '', ...(request.params ? { params: request.params } : {}) }]
                    : (request.steps ?? []);
                args = ['run'];
                if (context.project) {
                    args.push('--in', positional(context.project));
                }
                else if (context.demo) {
                    args.push('--sample', 'financial');
                }
                args.push(...commandArgs(steps));
                if (context.saveAs) {
                    args.push('--out', context.saveAs);
                    artifacts.push(context.saveAs);
                }
                else if (context.save && context.project) {
                    args.push('--out', context.project);
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
                args = ['convert', requireProject(context, 'render'), positional(output)];
                artifacts = [output];
                break;
            }
            default:
                throw new Error(`Unsupported grid engine action: ${request.action}`);
        }
        return {
            args,
            artifacts,
            timeoutMs: TIMEOUTS[request.action] ?? 60_000
        };
    }
};
