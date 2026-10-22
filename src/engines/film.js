const TIMEOUTS = {
    status: 10_000,
    catalog: 30_000,
    describe: 20_000,
    inspect: 60_000,
    execute: 120_000,
    batch: 300_000,
    export: 900_000,
    render: 300_000,
    probe: 120_000,
    install: 600_000
};
function baseArgs(request, context) {
    const args = [];
    if (context.demo)
        args.push('--demo');
    if (context.project)
        args.push('--project', context.project);
    if (context.saveAs)
        args.push('--save-as', context.saveAs);
    else if (context.save)
        args.push('--save');
    return args;
}
function outputArgs(request) {
    const args = [];
    if (request.preset)
        args.push('--preset', request.preset);
    if (request.format)
        args.push('--format', request.format);
    if (request.range)
        args.push('--range', request.range);
    if (request.start !== undefined)
        args.push('--start', String(request.start));
    if (request.end !== undefined)
        args.push('--end', String(request.end));
    if (request.scale !== undefined)
        args.push('--scale', String(request.scale));
    if (request.quality !== undefined)
        args.push('--quality', String(request.quality));
    if (request.allowOffline)
        args.push('--allow-offline');
    return args;
}
export const filmEngine = {
    id: 'film',
    label: 'Causyne Film Engine',
    envVar: 'CAUSYNE_ENGINE_FILM',
    binaryName: 'causyne-engine-film',
    actions: ['catalog', 'describe', 'inspect', 'execute', 'batch', 'export', 'render', 'probe'],
    invoke(request, context) {
        const args = baseArgs(request, context);
        let stdin;
        let artifacts = [];
        switch (request.action) {
            case 'catalog':
                args.push('commands');
                if (request.query)
                    args.push(request.query);
                args.push('--json');
                break;
            case 'describe':
                args.push('describe', request.command ?? '');
                break;
            case 'inspect':
                args.push('inspect', request.query || 'all');
                break;
            case 'execute':
                args.push('exec', request.command ?? '', JSON.stringify(request.params ?? {}));
                break;
            case 'batch':
                args.push('run', '-');
                if (context.keepGoing)
                    args.push('--keep-going');
                stdin = (request.steps ?? []).map(step => JSON.stringify(step)).join('\n') + '\n';
                break;
            case 'export':
                args.push('export', request.output ?? '', ...outputArgs(request));
                artifacts = [request.output ?? ''];
                break;
            case 'render':
                args.push('render', '--seconds', String(request.seconds ?? 0), '--out', request.output ?? '');
                if (request.scale !== undefined)
                    args.push('--scale', String(request.scale));
                if (request.allowOffline)
                    args.push('--allow-offline');
                artifacts = [request.output ?? ''];
                break;
            case 'probe':
                args.push('probe', request.query ?? '');
                break;
            case 'status':
                args.push('--version');
                break;
        }
        args.push('--compact');
        if (request.saveAs)
            artifacts = [request.saveAs];
        else if (request.save && context.project)
            artifacts = [context.project];
        return {
            args,
            ...(stdin === undefined ? {} : { stdin }),
            artifacts: artifacts.filter(Boolean),
            timeoutMs: TIMEOUTS[request.action]
        };
    }
};
