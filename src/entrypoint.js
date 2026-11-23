import fs from 'node:fs';
import { program } from 'commander';
import { runTask, chatMode, execCommand, interactiveConfig } from './cliMode.js';
import { runHeadlessTask, composeHeadlessPrompt, readBoundedStdin, parseOutputFormat, parsePermissionMode, parseMaxTurns, parseMaxTokens, parseMaxBudgetUsd, parseTimeoutMs } from './headlessCli.js';
import { runLicenseCommand } from './licensing/entitlements.js';
import { runSelfUpdate, diagnoseInstallation, formatDoctorReport } from './autoUpdate.js';
import { printContextReport, printUsageReport, printCheckpoints, printUndo, buildStatusText, printReport } from './reporting.js';
import { runCommand } from './commands.js';
import { resolveInvocation } from './tui/invocation.js';
import { safeDisplay } from './tui/text.js';
import { resolveUserPath } from './utils/paths.js';
import { getPackageVersion } from './version.js';
import { redactProviderSecrets } from './providers/byokHttp.js';
export function requestedWorkingDirectory(argv = []) {
    const tokens = Array.isArray(argv) ? argv.slice(2) : [];
    for (let index = 0; index < tokens.length; index++) {
        const token = String(tokens[index]);
        if (token === '--')
            break;
        if (token === '-C' || token === '--cwd')
            return String(tokens[index + 1] ?? '');
        if (token.startsWith('--cwd='))
            return token.slice('--cwd='.length);
        if (token.startsWith('-C') && token.length > 2)
            return token.slice(2);
    }
    return null;
}
function applyRequestedWorkingDirectory(argv) {
    const requested = requestedWorkingDirectory(argv);
    if (requested === null)
        return;
    if (!requested || requested.includes('\0'))
        throw new Error('The --cwd option requires a valid directory.');
    const resolved = resolveUserPath(requested);
    let stat;
    try {
        stat = fs.statSync(resolved);
    }
    catch {
        throw new Error(`The --cwd directory does not exist: ${requested}`);
    }
    if (!stat.isDirectory()) {
        throw new Error(`The --cwd target is not a directory: ${requested}`);
    }
    process.chdir(resolved);
}
applyRequestedWorkingDirectory(process.argv);
function announceDevEmulator(requested) {
    if (requested)
        console.log('Developer emulator mode is retired. Configure local budgets explicitly.');
}
async function confirmDestructive(question) {
    if (!process.stdin.isTTY || !process.stdout.isTTY)
        return false;
    const readline = (await import('node:readline')).default;
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const safeQuestion = safeDisplay(String(question ?? ''));
    try {
        const answer = await new Promise((resolve) => {
            let settled = false;
            const done = (value) => {
                if (settled)
                    return;
                settled = true;
                resolve(value);
            };
            rl.once('close', () => done(null));
            rl.question(`${safeQuestion} [y/N] `, (input) => done(input));
        });
        return answer !== null && /^y(es)?$/i.test(String(answer).trim());
    }
    finally {
        rl.close();
    }
}
const pkgVersion = getPackageVersion();
program
    .name('causyne')
    .description('Causyne — Local desktop AI harness (alias: causyne-agent)')
    .option('-C, --cwd <directory>', 'Use this directory as the workspace')
    .option('-p, --print [prompt]', 'Run a single non-interactive prompt and print the response')
    .option('--output-format <format>', 'Output format for headless runs: text, json, stream-json')
    .option('-m, --model <name>', 'Override model for this run without modifying saved config')
    .option('--provider <name>', 'Override provider for this run without modifying saved config')
    .option('--max-turns <count>', 'Maximum agent turns/steps for this run')
    .option('--max-tokens <count>', 'Maximum token budget for this headless run')
    .option('--max-budget-usd <usd>', 'Maximum USD spend ceiling for this headless run')
    .option('--timeout <seconds>', 'Wall-clock timeout in seconds for headless execution')
    .option('--resume', 'Reuse active workspace session instead of an isolated ephemeral session')
    .option('--json-schema <schema>', 'Require and validate JSON response matching inline JSON or file path')
    .option('--permission-mode <mode>', 'Autonomy mode override for this run (A, B, or C)')
    .version(pkgVersion)
    .action(async (options) => {
    if (options.print === undefined && !options.outputFormat) {
        if (program.args.length > 0) {
            console.error('Invalid command: %s\nSee --help for a list of available commands.', program.args.join(' '));
            process.exit(1);
        }
        program.outputHelp();
        process.exit(0);
    }
    try {
        parseOutputFormat(options.outputFormat);
        parsePermissionMode(options.permissionMode);
        parseMaxTurns(options.maxTurns);
        parseMaxTokens(options.maxTokens);
        parseMaxBudgetUsd(options.maxBudgetUsd);
        parseTimeoutMs(options.timeout);
        const stdinText = await readBoundedStdin(process.stdin);
        const trailing = program.args.length > 0 && typeof options.print === 'boolean'
            ? program.args.join(' ')
            : options.print;
        const prompt = composeHeadlessPrompt(trailing, stdinText);
        await runHeadlessTask(prompt, {
            outputFormat: options.outputFormat || 'text',
            model: options.model,
            provider: options.provider,
            maxTurns: options.maxTurns,
            maxTokens: options.maxTokens,
            maxBudgetUsd: options.maxBudgetUsd,
            timeoutSeconds: options.timeout,
            resumeSession: options.resume === true,
            jsonSchema: options.jsonSchema,
            permissionMode: options.permissionMode
        });
    }
    catch (err) {
        console.error(redactProviderSecrets(err instanceof Error ? err.message : String(err)));
        process.exit(2);
    }
});
program
    .command('update')
    .description('Check for and install the latest Causyne Agent release')
    .action(async () => {
    await runSelfUpdate(true);
});
program
    .command('doctor')
    .description('Inspect the installation, runtime and update channel')
    .action(async () => {
    const status = await diagnoseInstallation();
    printReport(formatDoctorReport(status), { title: 'Doctor' });
});
program
    .command('status')
    .description('Show local provider, workspace and runtime status')
    .action(() => printReport(buildStatusText(), { title: 'Status' }));
program
    .command('config')
    .alias('setup')
    .description('Guided provider, endpoint, model and autonomy setup')
    .option('-p, --provider <name>', 'Set LLM provider (openai, anthropic, gemini, muse, ollama, dashscope, deepseek)')
    .option('-k, --apikey <key>', 'Set API key')
    .option('-m, --model <name>', 'Set model name')
    .action(async (options) => {
    await interactiveConfig(options);
});
program
    .command('run [task]')
    .description('Run a single task directly from the CLI (supports piped stdin and --output-format)')
    .option('--dev-emulator', 'Retired compatibility flag; grants no additional permissions')
    .option('--output-format <format>', 'Output format: text, json, stream-json')
    .option('-m, --model <name>', 'Override model for this run without modifying saved config')
    .option('--provider <name>', 'Override provider for this run without modifying saved config')
    .option('--max-turns <count>', 'Maximum agent turns/steps for this run')
    .option('--max-tokens <count>', 'Maximum token budget for this headless run')
    .option('--max-budget-usd <usd>', 'Maximum USD spend ceiling for this headless run')
    .option('--timeout <seconds>', 'Wall-clock timeout in seconds for headless execution')
    .option('--resume', 'Reuse active workspace session instead of an isolated ephemeral session')
    .option('--json-schema <schema>', 'Require and validate JSON response matching inline JSON or file path')
    .option('--permission-mode <mode>', 'Autonomy mode override for this run (A, B, or C)')
    .action(async (task, options) => {
    announceDevEmulator(options.devEmulator);
    try {
        if (options.outputFormat)
            parseOutputFormat(options.outputFormat);
        parsePermissionMode(options.permissionMode);
        parseMaxTurns(options.maxTurns);
        parseMaxTokens(options.maxTokens);
        parseMaxBudgetUsd(options.maxBudgetUsd);
        parseTimeoutMs(options.timeout);
        const stdinText = await readBoundedStdin(process.stdin);
        const prompt = composeHeadlessPrompt(task, stdinText);
        if (!prompt) {
            console.error('No task provided. Pass a task argument or pipe input on stdin.');
            process.exit(2);
        }
        if (options.outputFormat || task === '-' || !task || options.jsonSchema || options.timeout || options.maxBudgetUsd || options.maxTokens) {
            await runHeadlessTask(prompt, {
                outputFormat: options.outputFormat || 'text',
                model: options.model,
                provider: options.provider,
                maxTurns: options.maxTurns,
                maxTokens: options.maxTokens,
                maxBudgetUsd: options.maxBudgetUsd,
                timeoutSeconds: options.timeout,
                resumeSession: options.resume === true,
                jsonSchema: options.jsonSchema,
                permissionMode: options.permissionMode
            });
        }
        else {
            await runTask(prompt, options);
        }
    }
    catch (err) {
        console.error(redactProviderSecrets(err instanceof Error ? err.message : String(err)));
        process.exit(2);
    }
});
program
    .command('chat')
    .description('Start interactive chat mode with the agent')
    .option('--dev-emulator', 'Retired compatibility flag; grants no additional permissions')
    .action(async (options) => {
    announceDevEmulator(options.devEmulator);
    await chatMode();
});
program
    .command('license [action] [plan]')
    .description('Show software access or open an authenticated payment checkout')
    .action(async (action = 'status', plan = '') => {
    await runLicenseCommand(action, plan);
});
program
    .command('context')
    .description('Show what fills the context window (tool schemas, window pool, spilled output)')
    .action(async () => {
    printContextReport();
});
program
    .command('usage')
    .description('Show BYOK token usage and estimated cost (today and lifetime)')
    .action(async () => {
    await printUsageReport();
});
program
    .command('checkpoints')
    .description('List recent undo checkpoints (files + conversation snapshots)')
    .option('-n, --limit <count>', 'How many task groups to show', '15')
    .action(async (options) => {
    const parsed = parseInt(String(options.limit ?? '15'), 10);
    const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(200, parsed) : 15;
    printCheckpoints(limit);
});
program
    .command('undo [taskId]')
    .description("Roll back the last task's file changes and rewind the conversation")
    .option('--step', 'Undo only the single most recent file change')
    .option('--full', 'Also roll back files changed by terminal commands (reverts your own manual edits too)')
    .option('--dry-run', 'Show what would change without writing anything')
    .option('-y, --yes', 'Do not ask for confirmation')
    .action(async (taskId, options) => {
    const opts = { step: options.step, dryRun: options.dryRun, full: options.full };
    if (!options.dryRun && !options.yes) {
        const { buildUndoText } = await import('./reporting.js');
        const preview = buildUndoText(taskId, { ...opts, dryRun: true });
        printReport(preview.text, { title: 'Undo preview' });
        if (!(await confirmDestructive('Apply this rollback?'))) {
            console.log('Cancelled. Nothing was written.');
            process.exit(0);
        }
    }
    const ok = printUndo(taskId, { ...opts, dryRun: options.dryRun === true ? true : false });
    process.exit(ok ? 0 : 1);
});
program
    .command('mcp [action] [args...]')
    .description('Manage MCP servers: list (default), add, remove, grant, revoke')
    .allowUnknownOption()
    .action(async (action, args) => {
    const argv = action ? [action, ...(args || [])] : [];
    const result = await runCommand('mcp', argv, { surface: 'terminal' });
    console.log('\n' + result.output + '\n');
    process.exit(result.ok ? 0 : 1);
});
program
    .command('peers [action] [args...]')
    .description('Manage external ACP peer agents: detect, list, test, add, remove')
    .allowUnknownOption()
    .action(async (action, args) => {
    const argv = action ? [action, ...(args || [])] : [];
    const result = await runCommand('peers', argv, { surface: 'terminal' });
    console.log('\n' + result.output + '\n');
    process.exit(result.ok ? 0 : 1);
});
program
    .command('policy [action]')
    .description('Inspect or validate enterprise policy rules (causyne.policy.json): status (default), validate')
    .action(async (action) => {
    const argv = action ? [action] : [];
    const result = await runCommand('policy', argv, { surface: 'terminal' });
    console.log('\n' + (result.output || '') + '\n');
    process.exit(result.ok ? 0 : 1);
});
program
    .command('audit [action]')
    .description('Inspect, verify, prune, or export local security audit logs: recent (default), verify, prune, export')
    .option('-f, --format <format>', 'Export format: jsonl, csv, or ocsf', 'jsonl')
    .option('-n, --limit <count>', 'Maximum audit entries to include')
    .option('--days <count>', 'Include logs from the last N calendar days')
    .option('--event <name>', 'Filter entries by exact event name')
    .option('--tool <name>', 'Filter entries by exact tool name')
    .option('-o, --output <file>', 'Write exported audit log to a file inside the workspace')
    .action(async (action, options) => {
    const argv = [];
    if (action)
        argv.push(action);
    if (options.format)
        argv.push('--format', String(options.format));
    if (options.limit !== undefined)
        argv.push('--limit', String(options.limit));
    if (options.days !== undefined)
        argv.push('--days', String(options.days));
    if (options.event)
        argv.push('--event', String(options.event));
    if (options.tool)
        argv.push('--tool', String(options.tool));
    if (options.output)
        argv.push('--output', String(options.output));
    const result = await runCommand('audit', argv, { surface: 'terminal' });
    if (result.ok && result.raw) {
        process.stdout.write(result.output || '');
    }
    else {
        console.log('\n' + (result.output || '') + '\n');
    }
    process.exit(result.ok ? 0 : 1);
});
program
    .command('lsp [action] [args...]')
    .description('Language Server Protocol code intelligence: status (default), diagnostics, symbols, hover, definition')
    .action(async (action, args) => {
    const argv = action ? [action, ...(args || [])] : [];
    const result = await runCommand('lsp', argv, { surface: 'terminal' });
    console.log('\n' + (result.output || '') + '\n');
    process.exit(result.ok ? 0 : 1);
});
program
    .command('worktree [action] [args...]')
    .description('Manage isolated git worktrees: list (default), create, diff, merge, remove, prune')
    .allowUnknownOption()
    .action(async (action, args) => {
    const argv = action ? [action, ...(args || [])] : [];
    const result = await runCommand('worktree', argv, { surface: 'terminal' });
    console.log('\n' + (result.output || '') + '\n');
    process.exit(result.ok ? 0 : 1);
});
program
    .command('diff [file]')
    .description('Review structured working-tree or staged unified diffs')
    .option('--staged', 'Show staged index changes')
    .option('--stat', 'Show file-level diff stats only')
    .option('--ref <gitRef>', 'Compare working tree against a git ref')
    .action(async (file, options) => {
    const argv = [];
    if (file)
        argv.push(file);
    if (options.staged)
        argv.push('--staged');
    if (options.stat)
        argv.push('--stat');
    if (options.ref)
        argv.push('--ref', String(options.ref));
    const result = await runCommand('diff', argv, { surface: 'terminal' });
    console.log('\n' + (result.output || '') + '\n');
    process.exit(result.ok ? 0 : 1);
});
program
    .command('pr [action] [arg]')
    .description('Pull Request & CI helper: status (default), draft [baseBranch], logs [runId]')
    .action(async (action, arg) => {
    const argv = [];
    if (action)
        argv.push(action);
    if (arg)
        argv.push(arg);
    const result = await runCommand('pr', argv, { surface: 'terminal' });
    console.log('\n' + (result.output || '') + '\n');
    process.exit(result.ok ? 0 : 1);
});
program
    .command('rules')
    .description('Show hierarchical project instructions loaded from CAUSYNE.md, AGENTS.md, CLAUDE.md, and .causyne/rules/')
    .action(async () => {
    const result = await runCommand('rules', [], { surface: 'terminal' });
    console.log('\n' + (result.output || '') + '\n');
    process.exit(result.ok ? 0 : 1);
});
program
    .command('map [focusFiles...]')
    .description('Render a PageRank-ranked repository symbol and dependency architecture map')
    .option('--chars <count>', 'Maximum output length in characters', '6000')
    .action(async (focusFiles, options) => {
    const argv = ['--chars', String(options.chars ?? '6000'), ...(focusFiles || [])];
    const result = await runCommand('map', argv, { surface: 'terminal' });
    console.log('\n' + (result.output || '') + '\n');
    process.exit(result.ok ? 0 : 1);
});
program
    .command('eval')
    .description('Run the reproducible Causyne coding & governance benchmark suite')
    .option('--json', 'Emit machine-readable JSON scorecard')
    .action(async (options) => {
    const argv = options.json ? ['--json'] : [];
    const result = await runCommand('eval', argv, { surface: 'terminal' });
    if (result.ok && result.raw) {
        process.stdout.write((result.output || '') + '\n');
    }
    else {
        console.log('\n' + (result.output || '') + '\n');
    }
    process.exit(result.ok ? 0 : 1);
});
program
    .command('continuum [action] [args...]')
    .alias('resume')
    .description('Cross-agent session extraction & resumption (Antigravity, OpenCode, Codex, Claude Code)')
    .allowUnknownOption()
    .action(async (action, args) => {
    const argv = action ? [action, ...(args || [])] : [];
    const result = await runCommand('continuum', argv, { surface: 'terminal' });
    console.log('\n' + (result.output || '') + '\n');
    process.exit(result.ok ? 0 : 1);
});
program
    .command('exec <command>')
    .description('Quick execute a command using the agent terminal')
    .action(async (command) => {
    await execCommand(command);
});
program
    .command('acp')
    .description('Start Causyne as an Agent Client Protocol (ACP) server over stdio')
    .action(async () => {
    const { AcpServer } = await import('./acp/server.js');
    const server = new AcpServer({
        input: process.stdin,
        output: process.stdout,
        agentVersion: getPackageVersion()
    });
    server.start();
});
program.on('command:*', function () {
    console.error('Invalid command: %s\nSee --help for a list of available commands.', program.args.join(' '));
    process.exit(1);
});
const invocation = resolveInvocation(process.argv);
if (invocation.isBareRoot) {
    if (!process.stdout.isTTY) {
        program.outputHelp();
        process.exit(0);
    }
    announceDevEmulator(invocation.rootOptions.includes('--dev-emulator'));
    chatMode({ home: true }).catch((e) => {
        const detail = e instanceof Error && e.stack ? e.stack : String(e);
        console.error(redactProviderSecrets(detail));
        process.exit(1);
    });
}
else {
    await program.parseAsync(process.argv);
}
