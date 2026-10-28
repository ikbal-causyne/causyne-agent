/**
 * Causyne Agent — System Command Execution (sysRun & sysRunBg)
 *
 * Provides robust subprocess execution with:
 * 1. Semantic exit code normalization (POSIX grep, diff, test, which, cmp exit codes
 *    treated as valid non-error queries rather than fatal crashes).
 * 2. In-memory execution deduplication cache for read-only / diagnostic commands
 *    to prevent infinite retry thrashing.
 * 3. ANSI color/control sequence stripping for clean tool output.
 * 4. Ring-buffered output truncation (50KB cap) to protect LLM context windows.
 */
import { spawn } from 'node:child_process';
import os from 'node:os';
import { isLaunchOnlyPrompt, isServerLaunchCommand } from '../launchIntent.js';
/**
 * Strips ANSI escape sequences and terminal control codes from string output.
 */
export function stripAnsi(str) {
    const pattern = [
        '[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)',
        '(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))'
    ].join('|');
    return str.replace(new RegExp(pattern, 'g'), '');
}
/**
 * Strips ANSI escape sequences and normalizes carriage returns so terminal split-panes never glitch.
 */
export function cleanSubprocessOutput(str) {
    return stripAnsi(str)
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n');
}
/**
 * Commands whose exit code 1 indicates a normal query result (e.g. no matches found,
 * differences found, or condition evaluated to false) rather than a system error.
 */
export const SEARCH_COMMAND_PATTERN = /(^|\s|\||&&|;)(grep|egrep|fgrep|diff|test|which|cmp|find)(\s|$)/;
/**
 * Commands that are strictly read-only and idempotent.
 * Repeated identical executions within a short TTL window return cached output.
 */
export const IDEMPOTENT_COMMAND_PATTERN = /^(python3?|node|bun|pnpm|npm)\s+(-v|--version|(-c|-e)\s+["'].*?["'])$|^ls\b|^cat\b|^head\b|^tail\b|^grep\b|^find\b|^which\b|^where\b|^pwd$|^git\s+(status|log|diff|branch|tag|show\b)|^echo\b/;
/**
 * Detect long-running dev servers and web application listeners that must not block foreground loops.
 */
export function isPersistentServerCommand(cmd) {
    if (!cmd || typeof cmd !== 'string')
        return false;
    const trimmed = cmd.trim();
    if (/^(?:cat|head|tail|grep|lsof|ps|kill|pkill|pgrep|curl|wget|echo|test)\b/i.test(trimmed)) {
        return false;
    }
    const patterns = [
        /(?:^|[;&|\s])(?:python[0-9.]*|node|deno|bun)\s+.*(?:server|app|main)\.(?:py|js|ts|mjs|cjs)\b/i,
        /(?:^|[;&|\s])python[0-9.]*\s+-m\s+http\.server\b/i,
        /(?:^|[;&|\s])(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve)\b/i,
        /(?:^|[;&|\s])(?:npx\s+)?(?:serve|vite|live-server|http-server)\b/i,
        /(?:^|[;&|\s])(?:flask\s+run|uvicorn|gunicorn)\b/i,
        /(?:^|[;&|\s])(?:\.\/start\.sh|bash\s+start\.sh|sh\s+start\.sh)\b/i
    ];
    return patterns.some(pattern => pattern.test(trimmed));
}
export const SERVER_READY_PATTERN = /(?:https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):[0-9]+|serving\s+http\s+on|server\s+(?:running|started)|ready\s+in\s+[0-9]+|terra_server_running)/i;
const COMMAND_CACHE_TTL_MS = 60_000;
const commandCache = new Map();
export function clearSysRunCache() {
    commandCache.clear();
}
export const sysRun = {
    schema: {
        name: 'sysRun',
        description: 'Execute a shell command. CRITICAL CONSTRAINTS: 1. NEVER use interactive flags (like git rebase -i). 2. Always use non-interactive flags (--yes, -y). 3. If running git commit, always run git status, git diff, and git log first.',
        parameters: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'The shell command to run' },
                cwd: { type: 'string', description: 'Working directory' },
                timeout: { type: 'number', description: 'Timeout in ms (default 60000)' }
            },
            required: ['command']
        }
    },
    async execute(args, context = {}) {
        const rawCommand = (args?.command || '').trim();
        const cwd = args?.cwd ? args.cwd.replace(/^~\//, os.homedir() + '/') : process.cwd();
        const timeoutMs = args?.timeout || 60000;
        const signal = context.signal;
        // A foreground server waits forever for requests. Keep launch-only turns
        // responsive and make it explicit that starting is not a readiness check.
        const taskPrompt = context.parentLoop?.currentTaskPrompt || context.parentLoop?.userPrompt || '';
        if (isLaunchOnlyPrompt(taskPrompt) && isServerLaunchCommand(rawCommand)) {
            const started = await sysRunBg.execute({ command: rawCommand, cwd, label: 'local-server' });
            return started.success
                ? { success: true, output: `Started server process ${started.pid} in background. Readiness and browser opening have not been verified.`, exitCode: 0, note: 'Check the server URL before reporting it accessible.' }
                : { success: false, output: '', error: started.error || 'Unable to start server process.', exitCode: 1 };
        }
        // Fast-path: Return cached output for identical read-only idempotent commands
        const isIdempotent = IDEMPOTENT_COMMAND_PATTERN.test(rawCommand);
        const cacheKey = `${cwd}:::${rawCommand}`;
        if (!context.skipCache && isIdempotent && commandCache.has(cacheKey)) {
            const cached = commandCache.get(cacheKey);
            if (Date.now() - cached.timestamp < COMMAND_CACHE_TTL_MS) {
                return {
                    success: cached.success,
                    output: cached.output,
                    exitCode: cached.exitCode,
                    cached: true,
                    note: cached.note || 'Returned cached output from recent identical execution.'
                };
            }
            commandCache.delete(cacheKey);
        }
        let executedCommand = rawCommand;
        if (os.platform() !== 'win32' && /(?:^|\s)&\s*$/.test(rawCommand) && !/[><]/.test(rawCommand)) {
            executedCommand = rawCommand.replace(/\s*&\s*$/, ' >/dev/null 2>&1 &');
        }
        return new Promise((resolve) => {
            const shell = os.platform() === 'win32' ? 'cmd.exe' : '/bin/bash';
            const shellArgs = os.platform() === 'win32' ? ['/c', executedCommand] : ['-c', executedCommand];
            let child;
            try {
                child = spawn(shell, shellArgs, { cwd, signal });
            }
            catch (err) {
                const errorMsg = err instanceof Error ? err.message : String(err);
                resolve({
                    success: false,
                    output: '',
                    error: errorMsg,
                    exitCode: 1
                });
                return;
            }
            // Phase 1 AGI Upgrade: 50KB Ring Buffer (FIFO)
            const MAX_LENGTH = 50000;
            let outputBuffer = '';
            let isDetached = false;
            const checkServerDetach = () => {
                if (isDetached)
                    return;
                if (isPersistentServerCommand(rawCommand) || isServerLaunchCommand(rawCommand)) {
                    if (SERVER_READY_PATTERN.test(outputBuffer)) {
                        isDetached = true;
                        if (timeoutId)
                            clearTimeout(timeoutId);
                        if (serverGraceTimer)
                            clearTimeout(serverGraceTimer);
                        child.unref();
                        resolve({
                            success: true,
                            output: cleanSubprocessOutput(outputBuffer),
                            exitCode: 0,
                            note: 'Server readiness verified. Running in background.'
                        });
                    }
                }
            };
            const appendToBuffer = (data) => {
                outputBuffer += data.toString();
                if (outputBuffer.length > MAX_LENGTH) {
                    outputBuffer = '...[OUTPUT TRUNCATED]...\n' + outputBuffer.slice(outputBuffer.length - MAX_LENGTH);
                }
                checkServerDetach();
            };
            child.stdout?.on('data', appendToBuffer);
            child.stderr?.on('data', appendToBuffer);
            let serverGraceTimer;
            if (isPersistentServerCommand(rawCommand) || isServerLaunchCommand(rawCommand)) {
                serverGraceTimer = setTimeout(() => {
                    if (!isDetached && child.exitCode === null) {
                        isDetached = true;
                        if (timeoutId)
                            clearTimeout(timeoutId);
                        child.unref();
                        resolve({
                            success: true,
                            output: cleanSubprocessOutput(outputBuffer) || 'Server process started and running in background.',
                            exitCode: 0,
                            note: 'Server detached after clean execution.'
                        });
                    }
                }, 2500);
            }
            let timeoutId;
            if (timeoutMs > 0) {
                timeoutId = setTimeout(() => {
                    if (isDetached)
                        return;
                    if (serverGraceTimer)
                        clearTimeout(serverGraceTimer);
                    child.kill('SIGKILL');
                    resolve({
                        success: false,
                        output: cleanSubprocessOutput(outputBuffer),
                        error: `Process timed out after ${timeoutMs}ms`,
                        exitCode: 124
                    });
                }, timeoutMs);
            }
            child.on('error', (err) => {
                if (isDetached)
                    return;
                if (timeoutId)
                    clearTimeout(timeoutId);
                if (serverGraceTimer)
                    clearTimeout(serverGraceTimer);
                resolve({
                    success: false,
                    output: cleanSubprocessOutput(outputBuffer),
                    error: err.message,
                    exitCode: 1
                });
            });
            child.on('close', (code) => {
                if (isDetached)
                    return;
                if (timeoutId)
                    clearTimeout(timeoutId);
                if (serverGraceTimer)
                    clearTimeout(serverGraceTimer);
                const cleanOutput = cleanSubprocessOutput(outputBuffer);
                const exitCode = typeof code === 'number' ? code : 1;
                if (exitCode === 0) {
                    const res = { success: true, output: cleanOutput, exitCode: 0 };
                    if (isIdempotent) {
                        commandCache.set(cacheKey, {
                            output: cleanOutput,
                            exitCode: 0,
                            success: true,
                            timestamp: Date.now()
                        });
                    }
                    resolve(res);
                }
                else if (exitCode === 1 && SEARCH_COMMAND_PATTERN.test(rawCommand)) {
                    // Semantic Exit Code Normalization: POSIX search tool found 0 matching lines.
                    const res = {
                        success: true,
                        output: cleanOutput || '(no matches found)',
                        exitCode: 1,
                        note: 'Command executed successfully with 0 search matches.'
                    };
                    if (isIdempotent) {
                        commandCache.set(cacheKey, {
                            output: res.output,
                            exitCode: 1,
                            success: true,
                            note: res.note,
                            timestamp: Date.now()
                        });
                    }
                    resolve(res);
                }
                else {
                    if (signal && signal.aborted) {
                        resolve({ success: false, output: cleanOutput, error: 'Process killed by user.', exitCode: 1 });
                    }
                    else {
                        resolve({ success: false, output: cleanOutput, error: `Command exited with code ${exitCode}`, exitCode });
                    }
                }
            });
        });
    }
};
export const sysRunBg = {
    schema: {
        name: 'sysRunBg',
        description: 'Start a long-running process in background (dev servers, watchers)',
        parameters: {
            type: 'object',
            properties: {
                command: { type: 'string' },
                cwd: { type: 'string' },
                label: { type: 'string' },
                maxDuration: { type: 'number' }
            },
            required: ['command', 'label']
        }
    },
    async execute(args) {
        try {
            const cwd = args.cwd ? args.cwd.replace(/^~\//, os.homedir() + '/') : process.cwd();
            const shell = os.platform() === 'win32' ? 'cmd.exe' : '/bin/bash';
            const shellArgs = os.platform() === 'win32' ? ['/c', args.command] : ['-c', args.command];
            return await new Promise(resolve => {
                const child = spawn(shell, shellArgs, { cwd, detached: true, stdio: 'ignore' });
                child.once('error', error => resolve({ success: false, error: error.message }));
                child.once('spawn', () => {
                    child.unref();
                    resolve({ success: true, output: `Background process launched [${args.label}]; readiness not verified.`, pid: child.pid });
                });
            });
        }
        catch (e) {
            const errorMsg = e instanceof Error ? e.message : String(e);
            return { success: false, error: errorMsg };
        }
    }
};
