import { spawn, spawnSync, execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { getEnhancedEnv } from './sysRun.js';
import { redactTextSecrets } from '../providers/byokHttp.js';
import { resolveOsSandboxMode, wrapCommandWithOsSandbox } from './osSandbox.js';
import { getErrorMessage, boundedInteger, resolveScopedPath, resolveToolWorkspaceRoots, sanitizeToolError, sanitizeToolText } from './toolPathSafety.js';
const MAX_PERSISTENT_SESSIONS = 8;
const MAX_BUFFER_CHARS = 256 * 1024;
const ALLOWED_POSIX_SHELLS = new Set(['/bin/sh', '/bin/bash', '/bin/zsh', '/usr/bin/bash', '/usr/bin/zsh', '/usr/local/bin/bash', '/usr/local/bin/zsh']);
const sessions = new Map();
function terminateShellProcess(session, force = false) {
    const proc = session.process;
    const pid = proc.pid;
    try {
        proc.stdin?.end();
    }
    catch { /* ignore */ }
    if (!pid)
        return;
    if (process.platform === 'win32') {
        try {
            if (force) {
                spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 2000 });
            }
            else {
                execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 4000 }, () => { });
            }
        }
        catch { /* ignore */ }
        try {
            proc.kill();
        }
        catch { /* ignore */ }
        return;
    }
    const sig = force ? 'SIGKILL' : 'SIGTERM';
    if (session.detachedGroup) {
        try {
            process.kill(-pid, sig);
            return;
        }
        catch { /* fall back to direct child */ }
    }
    try {
        proc.kill(sig);
    }
    catch { /* ignore */ }
}
export function cleanupPersistentShells() {
    for (const [, session] of sessions.entries()) {
        terminateShellProcess(session, true);
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
                const prevSession = sessions.get(sessionId);
                if (prevSession)
                    terminateShellProcess(prevSession, false);
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
                const ctxRecord = context;
                const workspaceRoots = scope.roots.length > 0 ? scope.roots : [initialCwd];
                let wrapped;
                if (ctxRecord.osSandbox && typeof ctxRecord.osSandbox === 'object') {
                    wrapped = wrapCommandWithOsSandbox(shellBin, shellArgs, {
                        ...ctxRecord.osSandbox,
                        cwd: ctxRecord.osSandbox.cwd || initialCwd,
                        workspaceRoots: ctxRecord.osSandbox.workspaceRoots || workspaceRoots
                    });
                }
                else {
                    const configMode = typeof ctxRecord.osSandbox === 'string'
                        ? ctxRecord.osSandbox
                        : ctxRecord.parentLoop?.config?.osSandbox;
                    const sandboxRes = resolveOsSandboxMode(process.env, configMode);
                    wrapped = wrapCommandWithOsSandbox(shellBin, shellArgs, {
                        mode: sandboxRes.mode,
                        strict: sandboxRes.strict,
                        allowNetwork: sandboxRes.allowNetwork,
                        cwd: initialCwd,
                        workspaceRoots
                    });
                }
                const detachedGroup = !isWin;
                const proc = spawn(wrapped.command, wrapped.args, {
                    cwd: initialCwd,
                    env: { ...getEnhancedEnv(), CAUSYNE_PERSISTENT_SHELL: '1', PS1: '' },
                    stdio: ['pipe', 'pipe', 'pipe'],
                    detached: detachedGroup,
                    windowsHide: true
                });
                proc.stdin.on('error', () => { });
                proc.on('error', () => { sessions.delete(sessionId); });
                proc.on('exit', () => { sessions.delete(sessionId); });
                session = {
                    process: proc,
                    currentCwd: initialCwd,
                    detachedGroup,
                    queue: Promise.resolve()
                };
                sessions.set(sessionId, session);
            }
            const activeSession = session;
            const runCommand = () => new Promise((resolve) => {
                const markerToken = `__CAUSYNE_PTY_DONE_${Date.now()}_${crypto.randomBytes(8).toString('hex')}__`;
                const markerWindowMax = Math.max(4096, markerToken.length * 4);
                let outputBuffer = '';
                let markerTailWindow = '';
                let stdoutTruncated = false;
                let errorBuffer = '';
                let isDone = false;
                const onData = (data) => {
                    const text = data.toString('utf8');
                    if (outputBuffer.length < MAX_BUFFER_CHARS) {
                        const room = MAX_BUFFER_CHARS - outputBuffer.length;
                        if (text.length <= room) {
                            outputBuffer += text;
                        }
                        else {
                            outputBuffer += text.slice(0, room);
                            stdoutTruncated = true;
                        }
                    }
                    else {
                        stdoutTruncated = true;
                    }
                    // Always track rolling tail window so markerToken is NEVER lost after >256KiB output
                    markerTailWindow += text;
                    if (markerTailWindow.length > markerWindowMax) {
                        markerTailWindow = markerTailWindow.slice(-markerWindowMax);
                    }
                    if (markerTailWindow.includes(markerToken)) {
                        finish();
                    }
                };
                const onErrorData = (data) => {
                    if (errorBuffer.length < MAX_BUFFER_CHARS) {
                        errorBuffer += data.toString('utf8').slice(0, MAX_BUFFER_CHARS - errorBuffer.length);
                    }
                };
                const onExit = () => {
                    if (!isDone) {
                        isDone = true;
                        cleanupListeners();
                        resolve({
                            success: false,
                            error: `Persistent shell exited before completing command. Output captured:\n${redactTextSecrets(outputBuffer)}\n${redactTextSecrets(errorBuffer)}`
                        });
                    }
                };
                const timer = setTimeout(() => {
                    if (!isDone) {
                        isDone = true;
                        cleanupListeners();
                        if (process.platform === 'win32') {
                            // On Windows, child.kill('SIGINT') terminates the whole PowerShell process; recycle cleanly.
                            terminateShellProcess(activeSession, false);
                            sessions.delete(sessionId);
                        }
                        else {
                            try {
                                if (activeSession.detachedGroup && activeSession.process.pid) {
                                    process.kill(-activeSession.process.pid, 'SIGINT');
                                }
                                else {
                                    activeSession.process.kill('SIGINT');
                                }
                            }
                            catch { /* ignore */ }
                        }
                        resolve({
                            success: false,
                            error: `Command timed out after ${timeoutMs}ms. Output captured so far:\n${sanitizeToolText(redactTextSecrets(outputBuffer), 4096)}\n${sanitizeToolText(redactTextSecrets(errorBuffer), 2048)}`
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
                    cleanOutput = redactTextSecrets(cleanOutput.trim(), [], { sanitizeTerminal: false });
                    const cleanErr = redactTextSecrets(errorBuffer.trim(), [], { sanitizeTerminal: false });
                    const sanitizedStdout = sanitizeToolText(cleanOutput || (cleanErr ? '' : '[No output]'), stdoutTruncated ? 65000 : 65536);
                    const finalStdout = stdoutTruncated
                        ? `${sanitizedStdout}\n...[stdout truncated at 256 KiB; command completed]`
                        : sanitizedStdout;
                    resolve({
                        success: true,
                        output: JSON.stringify({
                            sessionId,
                            status: 'Executed cleanly in stateful session',
                            ...(stdoutTruncated ? { truncated: true } : {}),
                            stdout: finalStdout,
                            stderr: cleanErr ? sanitizeToolText(cleanErr, 16384) : undefined
                        }, null, 2)
                    });
                };
                activeSession.process.stdout.on('data', onData);
                activeSession.process.stderr.on('data', onErrorData);
                activeSession.process.once('exit', onExit);
                const markerCmd = `echo "${markerToken}"`;
                activeSession.process.stdin.write(`${command}\n${markerCmd}\n`);
            });
            const previous = activeSession.queue;
            let release;
            activeSession.queue = new Promise((r) => { release = r; });
            await previous;
            try {
                return await runCommand();
            }
            finally {
                release();
            }
        }
        catch (e) {
            return { success: false, error: sanitizeToolError(e) };
        }
    }
};
