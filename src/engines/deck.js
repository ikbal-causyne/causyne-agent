import path from 'node:path';
const TIMEOUTS = {
    status: 10_000,
    catalog: 30_000,
    describe: 20_000,
    inspect: 60_000,
    execute: 180_000,
    batch: 600_000,
    export: 300_000,
    render: 120_000,
    probe: 60_000,
    install: 600_000
};
function positional(value) {
    return value.startsWith('-') ? `.${path.sep}${value}` : value;
}
function sourceArgs(context) {
    if (context.demo)
        return ['--sample'];
    if (context.project)
        return ['--in', positional(context.project)];
    return [];
}
function saveArgs(context) {
    if (context.saveAs)
        return { args: ['--save', positional(context.saveAs)], artifact: context.saveAs };
    if (context.save && context.project)
        return { args: ['--save', positional(context.project)], artifact: context.project };
    return { args: [] };
}
function commandArgs(steps) {
    const args = [];
    for (const step of steps) {
        args.push('--cmd', step.params && Object.keys(step.params).length > 0 ? `${step.id}=${JSON.stringify(step.params)}` : step.id);
    }
    return args;
}
export const deckEngine = {
    id: 'deck',
    label: 'Causyne Deck Engine',
    envVar: 'CAUSYNE_ENGINE_DECK',
    binaryName: 'causyne-engine-deck',
    actions: ['catalog', 'describe', 'inspect', 'execute', 'batch', 'export', 'render', 'probe'],
    invoke(request, context) {
        let args;
        let artifacts = [];
        switch (request.action) {
            case 'status':
                args = ['--version'];
                break;
            case 'catalog':
                args = ['commands', ...(request.query ? [request.query] : [])];
                break;
            case 'describe':
                args = ['describe', '--json', request.command ?? ''];
                break;
            case 'inspect': {
                if (context.project) {
                    args = ['info', positional(context.project)];
                }
                else if (context.demo) {
                    args = ['exec', '--sample', 'document.inspect'];
                }
                else {
                    throw new Error('inspect requires project or demo');
                }
                break;
            }
            case 'probe':
                args = ['info', positional(request.query ?? '')];
                break;
            case 'execute': {
                const out = saveArgs(context);
                args = ['exec', ...sourceArgs(context), ...out.args, request.command ?? '', JSON.stringify(request.params ?? {})];
                if (context.keepGoing)
                    throw new Error('The deck engine stops at the first failed command; keepGoing is not supported');
                if (out.artifact)
                    artifacts = [out.artifact];
                break;
            }
            case 'batch': {
                const out = saveArgs(context);
                args = ['run', ...sourceArgs(context), ...commandArgs(request.steps ?? []), ...out.args, '--json'];
                if (context.keepGoing)
                    throw new Error('The deck engine stops at the first failed command; keepGoing is not supported');
                if (out.artifact)
                    artifacts = [out.artifact];
                break;
            }
            case 'export':
                args = ['convert', positional(context.project ?? ''), positional(request.output ?? '')];
                artifacts = [request.output ?? ''];
                break;
            case 'render': {
                const slide = Math.max(0, Math.trunc(request.seconds ?? 0));
                args = ['render', ...sourceArgs(context), '--slide', String(slide), ...(request.scale !== undefined ? ['--scale', String(request.scale)] : []), positional(request.output ?? '')];
                artifacts = [request.output ?? ''];
                break;
            }
            default:
                throw new Error(`Unsupported deck engine action: ${request.action}`);
        }
        return { args, artifacts: artifacts.filter(Boolean), timeoutMs: TIMEOUTS[request.action] };
    }
};
