import { execFile } from 'node:child_process';
import os from 'node:os';
import { currentToolAutonomyMode } from '../approvalPolicy.js';
import { sanitizeSubprocessEnv } from './subprocessEnv.js';
import { getErrorMessage, resolveScopedPath, resolveToolWorkspaceRoots, sanitizeToolText } from './toolPathSafety.js';
export function parseGitArguments(raw) {
    if (typeof raw !== 'string' || !raw.trim())
        throw new Error('A Git subcommand is required.');
    if (raw.includes('\0'))
        throw new Error('Git commands cannot contain NUL bytes.');
    const argv = [];
    let token = '';
    let quote = null;
    let started = false;
    for (let i = 0; i < raw.length; i++) {
        const char = raw.charAt(i);
        const next = raw.charAt(i + 1);
        if (char === '\\' && quote !== "'" && next && /[\\\s"']/.test(next)) {
            token += next;
            started = true;
            i++;
            continue;
        }
        if (char === '"' || char === "'") {
            if (!quote) {
                quote = char;
                started = true;
                continue;
            }
            if (quote === char) {
                quote = null;
                continue;
            }
        }
        if (!quote && /[;&|><`$()\r\n]/.test(char)) {
            throw new Error('Git commands must contain one subcommand, without shell operators or substitution.');
        }
        if (!quote && /\s/.test(char)) {
            if (started) {
                argv.push(token);
                token = '';
                started = false;
            }
            continue;
        }
        token += char;
        started = true;
    }
    if (quote)
        throw new Error('Unterminated quote in Git command.');
    if (started)
        argv.push(token);
    if (!argv.length)
        throw new Error('A Git subcommand is required.');
    return argv;
}
export const gitExec = {
    schema: {
        name: 'gitOp',
        description: 'Execute a git command in the selected workspace. Destructive commands use the central session approval and sandbox policy.',
        parameters: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'Git subcommand (e.g., "status", "commit -m init")' },
                cwd: { type: 'string' }
            },
            required: ['command']
        }
    },
    async execute(args = {}, _context) {
        const cwd = String(args?.cwd || process.cwd()).replace(/^~\//, os.homedir() + '/');
        let argv;
        try {
            argv = parseGitArguments(args?.command);
        }
        catch (error) {
            return { success: false, error: getErrorMessage(error) };
        }
        const blockedGlobalFlags = new Set(['-c', '-C', '--git-dir', '--work-tree', '--exec-path', '--config-env', '--namespace', '--super-prefix']);
        const blockedFlagPrefixes = ['--git-dir=', '--work-tree=', '--exec-path=', '--config-env=', '--upload-pack=', '--receive-pack=', '--output=', '-c'];
        const subcommand = argv[0];
        if (!subcommand || subcommand.startsWith('-')) {
            return { success: false, error: 'Git command must start with a subcommand rather than global options.' };
        }
        for (const token of argv) {
            if (blockedGlobalFlags.has(token) || token === '--ext-diff' || token === '--upload-pack' || token === '--receive-pack') {
                return { success: false, error: `Disallowed Git option "${sanitizeToolText(token, 64)}" is blocked for workspace isolation.` };
            }
            if (blockedFlagPrefixes.some((prefix) => token.startsWith(prefix) && (prefix !== '-c' || token.length > 2))) {
                return { success: false, error: `Disallowed Git option "${sanitizeToolText(token, 64)}" is blocked for workspace isolation.` };
            }
        }
        if (subcommand === 'config' && argv.some((token) => /(?:sshcommand|fsmonitor|hookspath|credential\.helper|diff\.external|pager|alias\.)/i.test(token))) {
            return { success: false, error: 'Modifying command-executing Git config keys is blocked.' };
        }
        if (subcommand === 'rebase' && argv.some((arg) => arg === '-i' || arg === '--interactive')) {
            return { success: false, error: 'Interactive Git rebase is not supported. Use precise non-interactive commands.' };
        }
        const forcingPush = subcommand === 'push' && argv.slice(1).some((arg) => arg === '-f' || arg === '--force' || arg.startsWith('--force-with-lease'));
        const forcingBranch = subcommand === 'branch' && argv.includes('-D');
        if ((forcingPush || forcingBranch) && currentToolAutonomyMode() === undefined) {
            return { success: false, error: 'Destructive Git action requires the agent session approval and sandbox policy.' };
        }
        return new Promise((resolve) => {
            execFile('git', argv, { cwd, maxBuffer: 5 * 1024 * 1024 }, (error, stdout, stderr) => {
                const fullOutput = (stdout || '') + '\n' + (stderr || '');
                if (fullOutput.includes('CONFLICT (content): Merge conflict')) {
                    resolve({
                        success: false,
                        error: '[AUTONOMOUS CONFLICT DETECTED] Git merge conflict occurred. Inspect conflicted files, resolve exact markers and verify before continuing.',
                        output: fullOutput
                    });
                    return;
                }
                if (error) {
                    resolve({ success: false, output: stdout, error: stderr || error.message, exitCode: error.code });
                }
                else {
                    resolve({ success: true, output: stdout || stderr, exitCode: 0 });
                }
            });
        });
    }
};
