import { program } from 'commander';

import { runTask, chatMode, execCommand, interactiveConfig } from './cliMode.js';
import { runSelfUpdate } from './autoUpdate.js';
import { printContextReport, printUsageReport, printCheckpoints, printUndo, buildStatusText, printReport } from './reporting.js';
import { runCommand } from './commands.js';
import { resolveInvocation } from './tui/invocation.js';

// The old flag remains parseable only to explain its retirement.
function announceDevEmulator(requested) {
  if (requested) console.log('Developer emulator mode is retired. Configure local budgets explicitly.');
}
/**
 * Ask before something irreversible, without dragging in a prompt framework.
 *
 * These commands run outside the chat surface, so ChatPrompt's ConfirmLayer is
 * not available — it needs the live region to draw into. A bare readline
 * question is the honest primitive here. A non-TTY answers NO: an unattended
 * `causyne undo` in a script must not silently rewrite the working tree, and
 * `--yes` is the way a script says it meant it.
 */
async function confirmDestructive(question) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const readline = (await import('readline')).default;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise((resolve) => rl.question(`${question} [y/N] `, resolve));
    return /^y(es)?$/i.test(String(answer).trim());
  } finally {
    rl.close();
  }
}

import { getPackageVersion } from './version.js';
const pkgVersion = getPackageVersion();


program
  // The advertised name. `causyne-agent` still resolves to the same launcher via
  // the second entry in package.json "bin", but the help text has to teach ONE
  // name or it teaches neither — a user who typed `causyne` and is answered
  // "Usage: causyne-agent" reasonably concludes they ran the wrong thing.
  .name('causyne')
  .description('Causyne — Local desktop AI harness (alias: causyne-agent)')
  .version(pkgVersion);

program
  .command('update')
  .description('Show source update guidance (no automatic installation)')
  .action(async () => {
    await runSelfUpdate(true);
  });

program
  .command('status')
  .description('Show local provider, workspace and runtime status')
  .action(() => printReport(buildStatusText(), { title: 'Status' }));

program
  .command('config')
  .description('Configure Direct API Provider (Interactive)')
  .option('-p, --provider <name>', 'Set LLM provider (openai, anthropic, gemini, muse, ollama, dashscope, deepseek)')
  .option('-k, --apikey <key>', 'Set API key')
  .option('-m, --model <name>', 'Set model name')
  .action(async (options) => {
    await interactiveConfig(options);
  });

program
  .command('run <task>')
  .description('Run a single task directly from the CLI')
  .option('--dev-emulator', 'Retired compatibility flag; grants no additional permissions')
  .action(async (task, options) => {
    announceDevEmulator(options.devEmulator);
    await runTask(task);
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
    printCheckpoints(parseInt(options.limit, 10) || 15);
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

    // A rollback writes to the user's files, and this command had no gate at
    // all: `causyne undo` restored immediately. The preview is the same code
    // path with dryRun forced, so what is shown is exactly what will happen —
    // not a description of it.
    if (!options.dryRun && !options.yes) {
      const { buildUndoText } = await import('./reporting.js');
      const preview = buildUndoText(taskId, { ...opts, dryRun: true });
      printReport(preview.text, { title: 'Undo preview' });
      if (!(await confirmDestructive('Apply this rollback?'))) {
        console.log('Cancelled. Nothing was written.');
        process.exit(0);
      }
    }

    // Explicit now that the default is a preview: reaching here means either
    // --dry-run was asked for, or the user confirmed the preview above.
    const ok = printUndo(taskId, { ...opts, dryRun: options.dryRun === true ? true : false });
    process.exit(ok ? 0 : 1);
  });

program
  .command('mcp [action] [args...]')
  .description('Manage MCP servers: list (default), add, remove, grant, revoke')
  // An MCP invocation is somebody else's command line — `npx -y @scope/server`
  // is normal. Without this, commander claims `-y` as its own unknown option and
  // the add fails before it reaches us. (passThroughOptions() would be the
  // stricter tool but requires enablePositionalOptions() on the root command,
  // which would change parsing for every other subcommand.)
  .allowUnknownOption()
  .action(async (action, args) => {
    // Same registry the chat surfaces use, so `causyne-agent mcp` and `/mcp`
    // can never disagree about what a server is or what enabling one means.
    const argv = action ? [action, ...(args || [])] : [];
    const result = await runCommand('mcp', argv, { surface: 'terminal' });
    console.log('\n' + result.output + '\n');
    process.exit(result.ok ? 0 : 1);
  });

program
  .command('exec <command>')
  .description('Quick execute a command using the agent terminal')
  .action(async (command) => {
    await execCommand(command);
  });

// Setup fallback for missing commands
program.on('command:*', function () {
  console.error('Invalid command: %s\nSee --help for a list of available commands.', program.args.join(' '));
  process.exit(1);
});

// Bare `causyne` opens the application; anything else is a subcommand.
//
// This was `process.argv.length <= 2`, which is true only for the exact string
// `causyne`. resolveInvocation() consumes declared root options first, so
// `causyne --dev-emulator` is still bare, while an unknown option or any bare
// word still goes to Commander to be dispatched or rejected. See
// src/tui/invocation.js for why each rule is conservative in that direction.
const invocation = resolveInvocation(process.argv);

if (invocation.isBareRoot) {
  if (!process.stdout.isTTY) {
    // Nothing can be interactive here, and printing a wordmark into a pipe is
    // noise. `causyne | cat` behaves like every other CLI: it says what it does.
    program.outputHelp();
    process.exit(0);
  }
  announceDevEmulator(invocation.rootOptions.includes('--dev-emulator'));
  // A missing key is a hint on the home screen, not a gate in front of it.
  chatMode({ home: true }).catch((e) => {
    console.error(e && e.stack ? e.stack : e);
    process.exit(1);
  });
} else {
  program.parse(process.argv);
}
