/**
 * Causyne Agent — Managed OS-Sandboxed Background Task Runner (Phase C-Core)
 *
 * Launches, tracks, streams incremental output from, waits on, and terminates
 * long-running workspace commands (dev servers, test runners, build watchers)
 * under the same OS kernel sandbox boundary (`wrapCommandWithOsSandbox`) as
 * `sysRun` and `persistentShell`.
 */
import { spawn, execFile, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { getEnhancedEnv } from './tools/sysRun.js';
import { resolveOsSandboxMode, wrapCommandWithOsSandbox } from './tools/osSandbox.js';
import { redactTextSecrets } from './providers/byokHttp.js';
import { safeDisplay } from './tui/text.js';
const MAX_CONCURRENT_BG_TASKS = 8;
const MAX_RETAINED_BG_TASKS = 32;
const MAX_TASK_BUFFER_CHARS = 256 * 1024;
const MAX_CHUNK_READ_CHARS = 32 * 1024;
export class BackgroundTaskManager {
    tasks = new Map();
    pruneFinished() {
        if (this.tasks.size <= MAX_RETAINED_BG_TASKS)
            return;
        for (const [id, rec] of this.tasks.entries()) {
            if (this.tasks.size <= MAX_RETAINED_BG_TASKS)
                break;
            if (rec.status !== 'running')
                this.tasks.delete(id);
        }
    }
    toSnapshot(rec) {
        return {
            taskId: rec.taskId,
            label: rec.label,
            command: rec.command,
            cwd: rec.cwd,
            pid: rec.pid,
            status: rec.status,
            exitCode: rec.exitCode,
            signal: rec.signal,
            sandboxed: rec.sandboxed,
            sandboxBackend: rec.sandboxBackend,
            startedAt: rec.startedAt,
            endedAt: rec.endedAt,
            outputBytes: rec.baseOffset + rec.outputBuffer.length
        };
    }
    start(options) {
        const command = String(options.command || '').trim();
        if (!command || command.includes('\0')) {
            throw new Error('Background task command must be a non-empty string without NUL bytes.');
        }
        const runningCount = [...this.tasks.values()].filter((t) => t.status === 'running').length;
        if (runningCount >= MAX_CONCURRENT_BG_TASKS) {
            throw new Error(`Maximum concurrent background tasks (${MAX_CONCURRENT_BG_TASKS}) reached. Stop an active task first.`);
        }
        const isWin = process.platform === 'win32';
        const shellBin = isWin ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh';
        const shellArgs = isWin ? ['/d', '/s', '/c', `"${command}"`] : ['-c', command];
        const roots = options.workspaceRoots.length > 0 ? options.workspaceRoots : [options.cwd];
        const wrapped = options.osSandbox && typeof options.osSandbox === 'object'
            ? wrapCommandWithOsSandbox(shellBin, shellArgs, {
                ...options.osSandbox,
                cwd: options.osSandbox.cwd || options.cwd,
                workspaceRoots: options.osSandbox.workspaceRoots || roots
            })
            : (() => {
                const modeRes = resolveOsSandboxMode(process.env, typeof options.osSandbox === 'string' ? options.osSandbox : undefined);
                return wrapCommandWithOsSandbox(shellBin, shellArgs, {
                    mode: modeRes.mode,
                    strict: modeRes.strict,
                    allowNetwork: modeRes.allowNetwork,
                    cwd: options.cwd,
                    workspaceRoots: roots
                });
            })();
        const taskId = `bg_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
        const label = safeDisplay(options.label?.trim() || command.slice(0, 60));
        const detachedGroup = !isWin;
        const proc = spawn(wrapped.command, wrapped.args, {
            cwd: options.cwd,
            env: getEnhancedEnv(),
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: false,
            detached: detachedGroup,
            windowsHide: true,
            ...(isWin && !wrapped.sandboxed ? { windowsVerbatimArguments: true } : {})
        });
        // Background tasks are non-interactive; closing stdin immediately prevents
        // sandboxed shells or bwrap supervisors from blocking on stdin EOF.
        try {
            proc.stdin.end();
        }
        catch { /* ignore */ }
        const record = {
            taskId,
            label,
            command: safeDisplay(redactTextSecrets(command)).slice(0, 300),
            cwd: options.cwd,
            pid: proc.pid ?? null,
            status: 'running',
            exitCode: null,
            signal: null,
            sandboxed: wrapped.sandboxed,
            sandboxBackend: wrapped.backend,
            startedAt: new Date().toISOString(),
            endedAt: null,
            outputBytes: 0,
            proc,
            outputBuffer: '',
            baseOffset: 0,
            detachedGroup,
            waiters: []
        };
        const append = (chunk) => {
            const text = redactTextSecrets(chunk.toString('utf8'));
            record.outputBuffer += text;
            if (record.outputBuffer.length > MAX_TASK_BUFFER_CHARS) {
                const drop = record.outputBuffer.length - MAX_TASK_BUFFER_CHARS;
                record.outputBuffer = record.outputBuffer.slice(drop);
                record.baseOffset += drop;
            }
            record.outputBytes = record.baseOffset + record.outputBuffer.length;
        };
        proc.stdout.on('data', append);
        proc.stderr.on('data', append);
        let finalized = false;
        const finalize = (code, sig) => {
            if (finalized)
                return;
            finalized = true;
            const wasStopped = record.status === 'stopped';
            if (record.status === 'running') {
                record.status = code === 0 ? 'completed' : 'failed';
            }
            record.exitCode = code;
            record.signal = sig;
            record.endedAt = new Date().toISOString();
            if (wasStopped) {
                // Ensure any remaining process-group sibling (e.g. Linux bwrap inner init)
                // is terminated and stdio pipes are closed so the parent event loop cannot hang.
                this.signalProcessTree(record, 'SIGKILL', false);
                try {
                    proc.stdin?.destroy();
                }
                catch { /* ignore */ }
                try {
                    proc.stdout?.destroy();
                }
                catch { /* ignore */ }
                try {
                    proc.stderr?.destroy();
                }
                catch { /* ignore */ }
            }
            record.proc = null;
            const waiters = record.waiters.splice(0);
            for (const wake of waiters)
                wake();
            this.pruneFinished();
        };
        proc.on('error', (err) => {
            append(Buffer.from(`\n[process error] ${err.message}\n`, 'utf8'));
            finalize(1, null);
        });
        proc.on('close', (code, sig) => finalize(code, sig));
        proc.on('exit', (code, sig) => {
            if (record.status === 'stopped') {
                finalize(code, sig);
            }
        });
        this.tasks.set(taskId, record);
        return this.toSnapshot(record);
    }
    list() {
        return [...this.tasks.values()].map((r) => this.toSnapshot(r));
    }
    status(taskId) {
        const rec = this.tasks.get(taskId);
        return rec ? this.toSnapshot(rec) : null;
    }
    readOutput(taskId, offset = 0, maxChars = MAX_CHUNK_READ_CHARS) {
        const rec = this.tasks.get(taskId);
        if (!rec)
            throw new Error(`Background task "${safeDisplay(taskId)}" not found.`);
        const totalLength = rec.baseOffset + rec.outputBuffer.length;
        const requested = Math.max(0, Math.floor(offset));
        const effectiveOffset = Math.max(rec.baseOffset, Math.min(totalLength, requested));
        const relStart = effectiveOffset - rec.baseOffset;
        const safeMax = Math.max(256, Math.min(MAX_CHUNK_READ_CHARS, Math.floor(maxChars)));
        const slice = rec.outputBuffer.slice(relStart, relStart + safeMax);
        const nextOffset = effectiveOffset + slice.length;
        return {
            status: this.toSnapshot(rec),
            output: safeDisplay(slice),
            nextOffset,
            droppedChars: rec.baseOffset,
            hasMore: nextOffset < totalLength
        };
    }
    async wait(taskId, timeoutMs = 15_000) {
        const rec = this.tasks.get(taskId);
        if (!rec)
            throw new Error(`Background task "${safeDisplay(taskId)}" not found.`);
        if (rec.status !== 'running' && !rec.proc)
            return this.toSnapshot(rec);
        const bounded = Math.max(50, Math.min(120_000, Math.floor(timeoutMs)));
        await new Promise((resolve) => {
            let done = false;
            const finish = () => {
                if (done)
                    return;
                done = true;
                clearTimeout(timer);
                resolve();
            };
            const timer = setTimeout(finish, bounded);
            timer.unref?.();
            rec.waiters.push(finish);
        });
        return this.toSnapshot(rec);
    }
    signalProcessTree(rec, signal, sync = false) {
        const procRef = rec.proc;
        const pid = procRef?.pid ?? rec.pid;
        if (!pid || pid <= 0)
            return;
        if (process.platform === 'win32') {
            try {
                if (sync) {
                    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
                        stdio: 'ignore',
                        windowsHide: true,
                        timeout: 2000
                    });
                }
                else {
                    execFile('taskkill', ['/PID', String(pid), '/T', '/F'], {
                        windowsHide: true,
                        timeout: 4000
                    }, () => { });
                }
            }
            catch { /* ignore */ }
            try {
                procRef?.kill();
            }
            catch { /* ignore */ }
            return;
        }
        if (rec.detachedGroup) {
            try {
                process.kill(-pid, signal);
                return;
            }
            catch {
                // Fall through to direct child kill when process group already exited
            }
        }
        try {
            procRef?.kill(signal);
        }
        catch { /* ignore */ }
    }
    stop(taskId, options = {}) {
        const rec = this.tasks.get(taskId);
        if (!rec)
            throw new Error(`Background task "${safeDisplay(taskId)}" not found.`);
        if (rec.proc) {
            rec.status = 'stopped';
            const procRef = rec.proc;
            try {
                procRef.stdin?.end();
            }
            catch { /* ignore */ }
            const forceCleanup = () => {
                this.signalProcessTree(rec, 'SIGKILL', Boolean(options.force));
                try {
                    procRef.kill('SIGKILL');
                }
                catch { /* ignore */ }
                try {
                    procRef.stdin?.destroy();
                }
                catch { /* ignore */ }
                try {
                    procRef.stdout?.destroy();
                }
                catch { /* ignore */ }
                try {
                    procRef.stderr?.destroy();
                }
                catch { /* ignore */ }
            };
            if (options.force) {
                forceCleanup();
            }
            else {
                this.signalProcessTree(rec, 'SIGTERM', false);
                const killTimer = setTimeout(() => {
                    if (rec.proc === procRef || (procRef.exitCode === null && procRef.signalCode === null)) {
                        forceCleanup();
                    }
                }, 750);
                killTimer.unref?.();
            }
            if (typeof procRef.unref === 'function') {
                try {
                    procRef.unref();
                }
                catch { /* ignore */ }
            }
        }
        return this.toSnapshot(rec);
    }
    stopAll(force = false) {
        for (const id of this.tasks.keys()) {
            try {
                this.stop(id, { force });
            }
            catch { /* ignore */ }
        }
    }
}
export const backgroundTaskManager = new BackgroundTaskManager();
process.on('exit', () => {
    backgroundTaskManager.stopAll(true);
});
