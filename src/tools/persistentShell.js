import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { getEnhancedEnv } from './sysRun.js';
import { getErrorMessage, boundedInteger, resolveScopedPath, resolveToolWorkspaceRoots, sanitizeToolError, sanitizeToolText } from './toolPathSafety.js';
const MAX_PERSISTENT_SESSIONS = 8;
const MAX_BUFFER_CHARS = 256 * 1024;
const ALLOWED_POSIX_SHELLS = new Set(['/bin/sh', '/bin/bash', '/bin/zsh', '/usr/bin/bash', '/usr/bin/zsh', '/usr/local/bin/bash', '/usr/local/bin/zsh']);
const sessions = new Map();
export function cleanupPersistentShells() {
    for (const [, session] of sessions.entries()) {
        try {
            session.process.kill('SIGTERM');
        }
        catch { /* ignore */ }
    }
    sessions.clear();
}
process.on('exit', cleanupPersistentShells);
export const persistentShell = {
    schema: {
        name: 'terminal.persistent_shell',
        description: 'Executes shell commands in a stateful, persistent REPL session where working directory (cd), virtual environment activation, and environment variables persist across sequential calls. Surpasses stateless execution.',
        parameters: {
            type: 'object',
            properties: {
                command: { type: 'string', description: 'Shell command line string to execute inside the persistent session.' },
                sessionId: { type: 'string', description: 'Unique identifier for the shell session. Defaults to "default".' },
                reset: { type: 'boolean', description: 'Set to true to kill the existing session and spawn a fresh terminal shell.' },
                timeoutMs: { type: 'integer', description: 'Maximum execution time in milliseconds before timing out. Defaults to 30000.' }
            },
            required: ['command']
        }
    },
    async execute(args = {}, context = {}) {
        try {
            const safeArgs = args && typeof args === 'object' ? args : {};
            const command = safeArgs.command;
            if (typeof command !== 'string' || !command.trim())
                return { success: false, error: 'Command parameter is required.' };
            if (command.includes('\0'))
                return { success: false, error: 'Command cannot contain NUL bytes.' };
            const sessionId = typeof safeArgs.sessionId === 'string' && safeArgs.sessionId.trim()
                ? safeArgs.sessionId.trim().slice(0, 64)
                : 'default';
            const reset = safeArgs.reset === true;
            const timeoutMs = boundedInteger(safeArgs.timeoutMs, 30000, 1000, 120_000);
            if (reset && sessions.has(sessionId)) {
                try {
                    sessions.get(sessionId)?.process.kill('SIGTERM');
                }
                catch { /* ignore */ }
                sessions.delete(sessionId);
            }
            let session = sessions.get(sessionId);
            if (!session) {
                if (sessions.size >= MAX_PERSISTENT_SESSIONS) {
                    return { success: false, error: `Maximum persistent shell sessions (${MAX_PERSISTENT_SESSIONS}) reached. Reset or reuse an existing sessionId.` };
                }
                const isWin = process.platform === 'win32';
                const envShell = process.env.SHELL || '';
                const shellBin = isWin
                    ? 'powershell.exe'
                    : (ALLOWED_POSIX_SHELLS.has(envShell) ? envShell : '/bin/sh');
                const shellArgs = isWin ? ['-NoLogo', '-NoProfile', '-NoExit', '-Command', '-'] : [];
                const scope = resolveToolWorkspaceRoots(context);
                const initialCwd = typeof safeArgs.cwd === 'string' && safeArgs.cwd.trim()
                    ? resolveScopedPath(safeArgs.cwd, context)
                    : (scope.primaryRoot || process.cwd());
                const proc = spawn(shellBin, shellArgs, {
                    cwd: initialCwd,
                    env: { ...getEnhancedEnv(), CAUSYNE_PERSISTENT_SHELL: '1', PS1: '' },
                    stdio: ['pipe', 'pipe', 'pipe'],
                    windowsHide: true
                });
                proc.stdin.on('error', () => { });
                proc.on('error', () => { sessions.delete(sessionId); });
                proc.on('exit', () => { sessions.delete(sessionId); });
                session = {
                    process: proc,
                    currentCwd: initialCwd,
                    queue: Promise.resolve()
                };
                sessions.set(sessionId, session);
            }
            const activeSession = session;
            return await new Promise((resolve) => {
                const markerToken = `__CAUSYNE_PTY_DONE_${Date.now()}_${crypto.randomBytes(6).toString('hex')}__`;
                let outputBuffer = '';
                let errorBuffer = '';
                let isDone = false;
                const onData = (data) => {
                    outputBuffer += data.toString('utf8');
                    if (outputBuffer.includes(markerToken)) {
                        finish();
                    }
                };
                const onErrorData = (data) => {
                    errorBuffer += data.toString('utf8');
                };
                const onExit = () => {
                    if (!isDone) {
                        isDone = true;
                        cleanupListeners();
                        resolve({
                            success: false,
                            error: `Persistent shell exited before completing command. Output captured:\n${outputBuffer}\n${errorBuffer}`
                        });
                    }
                };
                const timer = setTimeout(() => {
                    if (!isDone) {
                        isDone = true;
                        cleanupListeners();
                        resolve({
                            success: false,
                            error: `Command timed out after ${timeoutMs}ms. Output captured so far:\n${outputBuffer}\n${errorBuffer}`
                        });
                    }
                }, timeoutMs);
                const cleanupListeners = () => {
                    activeSession.process.stdout.removeListener('data', onData);
                    activeSession.process.stderr.removeListener('data', onErrorData);
                    activeSession.process.removeListener('exit', onExit);
                    clearTimeout(timer);
                };
                const finish = () => {
                    if (isDone)
                        return;
                    isDone = true;
                    cleanupListeners();
                    const markerIndex = outputBuffer.indexOf(markerToken);
                    let cleanOutput = markerIndex !== -1 ? outputBuffer.substring(0, markerIndex) : outputBuffer;
                    const markerEchoLine = `echo "${markerToken}"`;
                    while (cleanOutput.includes(markerEchoLine)) {
                        cleanOutput = cleanOutput.split(markerEchoLine).join('');
                    }
                    cleanOutput = cleanOutput.trim();
                    resolve({
                        success: true,
                        output: JSON.stringify({
                            sessionId,
                            status: 'Executed cleanly in stateful session',
                            stdout: cleanOutput || (errorBuffer ? '' : '[No output]'),
                            stderr: errorBuffer.trim() || undefined
                        }, null, 2)
                    });
                };
                activeSession.process.stdout.on('data', onData);
                activeSession.process.stderr.on('data', onErrorData);
                activeSession.process.once('exit', onExit);
                const markerCmd = `echo "${markerToken}"`;
                activeSession.process.stdin.write(`${command}\n${markerCmd}\n`);
            });
        }
        catch (e) {
            return { success: false, error: getErrorMessage(e) };
        }
    }
};
