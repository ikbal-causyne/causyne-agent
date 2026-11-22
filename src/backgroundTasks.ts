/**
 * Causyne Agent — Managed OS-Sandboxed Background Task Runner (Phase C-Core)
 *
 * Launches, tracks, streams incremental output from, waits on, and terminates
 * long-running workspace commands (dev servers, test runners, build watchers)
 * under the same OS kernel sandbox boundary (`wrapCommandWithOsSandbox`) as
 * `sysRun` and `persistentShell`.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import crypto from 'node:crypto';
import { getEnhancedEnv } from './tools/sysRun.js';
import { resolveOsSandboxMode, wrapCommandWithOsSandbox, type OsSandboxWrapOptions } from './tools/osSandbox.js';
import { redactTextSecrets } from './providers/byokHttp.js';
import { safeDisplay } from './tui/text.js';

export type BackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'stopped';

export interface BackgroundTaskSnapshot {
  taskId: string;
  label: string;
  command: string;
  cwd: string;
  pid: number | null;
  status: BackgroundTaskStatus;
  exitCode: number | null;
  signal: string | null;
  sandboxed: boolean;
  sandboxBackend: string;
  startedAt: string;
  endedAt: string | null;
  outputBytes: number;
}

interface ManagedTaskRecord extends BackgroundTaskSnapshot {
  proc: ChildProcessWithoutNullStreams | null;
  outputBuffer: string;
  waiters: Array<() => void>;
}

const MAX_CONCURRENT_BG_TASKS = 8;
const MAX_RETAINED_BG_TASKS = 32;
const MAX_TASK_BUFFER_CHARS = 256 * 1024;
const MAX_CHUNK_READ_CHARS = 32 * 1024;

export class BackgroundTaskManager {
  private tasks = new Map<string, ManagedTaskRecord>();

  private pruneFinished(): void {
    if (this.tasks.size <= MAX_RETAINED_BG_TASKS) return;
    for (const [id, rec] of this.tasks.entries()) {
      if (this.tasks.size <= MAX_RETAINED_BG_TASKS) break;
      if (rec.status !== 'running') this.tasks.delete(id);
    }
  }

  private toSnapshot(rec: ManagedTaskRecord): BackgroundTaskSnapshot {
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
      outputBytes: rec.outputBuffer.length
    };
  }

  start(options: {
    command: string;
    cwd: string;
    workspaceRoots: readonly string[];
    label?: string | undefined;
    osSandbox?: string | OsSandboxWrapOptions | undefined;
  }): BackgroundTaskSnapshot {
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

    const proc = spawn(wrapped.command, wrapped.args, {
      cwd: options.cwd,
      env: getEnhancedEnv(),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      ...(isWin && !wrapped.sandboxed ? { windowsVerbatimArguments: true } : {})
    });

    const record: ManagedTaskRecord = {
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
      waiters: []
    };

    const append = (chunk: Buffer): void => {
      const text = redactTextSecrets(chunk.toString('utf8'));
      record.outputBuffer += text;
      if (record.outputBuffer.length > MAX_TASK_BUFFER_CHARS) {
        record.outputBuffer = record.outputBuffer.slice(-MAX_TASK_BUFFER_CHARS);
      }
      record.outputBytes = record.outputBuffer.length;
    };

    proc.stdout.on('data', append);
    proc.stderr.on('data', append);

    const finalize = (code: number | null, sig: NodeJS.Signals | null): void => {
      if (record.status === 'running') {
        record.status = code === 0 ? 'completed' : 'failed';
      }
      record.exitCode = code;
      record.signal = sig;
      record.endedAt = new Date().toISOString();
      record.proc = null;
      const waiters = record.waiters.splice(0);
      for (const wake of waiters) wake();
      this.pruneFinished();
    };

    proc.on('error', (err: Error) => {
      append(Buffer.from(`\n[process error] ${err.message}\n`, 'utf8'));
      finalize(1, null);
    });
    proc.on('exit', (code, sig) => finalize(code, sig));

    this.tasks.set(taskId, record);
    return this.toSnapshot(record);
  }

  list(): BackgroundTaskSnapshot[] {
    return [...this.tasks.values()].map((r) => this.toSnapshot(r));
  }

  status(taskId: string): BackgroundTaskSnapshot | null {
    const rec = this.tasks.get(taskId);
    return rec ? this.toSnapshot(rec) : null;
  }

  readOutput(taskId: string, offset = 0, maxChars = MAX_CHUNK_READ_CHARS): {
    status: BackgroundTaskSnapshot;
    output: string;
    nextOffset: number;
    hasMore: boolean;
  } {
    const rec = this.tasks.get(taskId);
    if (!rec) throw new Error(`Background task "${safeDisplay(taskId)}" not found.`);
    const safeOffset = Math.max(0, Math.min(rec.outputBuffer.length, Math.floor(offset)));
    const safeMax = Math.max(256, Math.min(MAX_CHUNK_READ_CHARS, Math.floor(maxChars)));
    const slice = rec.outputBuffer.slice(safeOffset, safeOffset + safeMax);
    const nextOffset = safeOffset + slice.length;
    return {
      status: this.toSnapshot(rec),
      output: safeDisplay(slice),
      nextOffset,
      hasMore: nextOffset < rec.outputBuffer.length
    };
  }

  async wait(taskId: string, timeoutMs = 15_000): Promise<BackgroundTaskSnapshot> {
    const rec = this.tasks.get(taskId);
    if (!rec) throw new Error(`Background task "${safeDisplay(taskId)}" not found.`);
    if (rec.status !== 'running') return this.toSnapshot(rec);
    const bounded = Math.max(50, Math.min(120_000, Math.floor(timeoutMs)));
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
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

  stop(taskId: string): BackgroundTaskSnapshot {
    const rec = this.tasks.get(taskId);
    if (!rec) throw new Error(`Background task "${safeDisplay(taskId)}" not found.`);
    if (rec.status === 'running' && rec.proc) {
      rec.status = 'stopped';
      try { rec.proc.kill('SIGTERM'); } catch { /* ignore */ }
      const procRef = rec.proc;
      const killTimer = setTimeout(() => {
        if (procRef.exitCode === null && !procRef.killed) {
          try { procRef.kill('SIGKILL'); } catch { /* ignore */ }
        }
      }, 2500);
      killTimer.unref?.();
    }
    return this.toSnapshot(rec);
  }

  stopAll(): void {
    for (const id of this.tasks.keys()) {
      try { this.stop(id); } catch { /* ignore */ }
    }
  }
}

export const backgroundTaskManager = new BackgroundTaskManager();

process.on('exit', () => {
  backgroundTaskManager.stopAll();
});
