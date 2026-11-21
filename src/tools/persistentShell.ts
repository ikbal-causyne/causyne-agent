import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import crypto from 'node:crypto';
import os from 'node:os';
import { getEnhancedEnv } from './sysRun.js';
import { getErrorMessage, type ToolWorkspaceContext } from './toolPathSafety.js';

interface PersistentShellSession {
  process: ChildProcessWithoutNullStreams;
  currentCwd: string;
  queue: Promise<void>;
}

export interface PersistentShellArgs {
  command?: string | undefined;
  sessionId?: string | undefined;
  reset?: boolean | undefined;
  timeoutMs?: number | undefined;
  cwd?: string | undefined;
}

export interface PersistentShellResult {
  success: boolean;
  output?: string | undefined;
  error?: string | undefined;
}

const sessions = new Map<string, PersistentShellSession>();

export function cleanupPersistentShells(): void {
  for (const [, session] of sessions.entries()) {
    try {
      session.process.kill('SIGTERM');
    } catch { /* ignore */ }
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

  async execute(args: PersistentShellArgs = {}, _context: ToolWorkspaceContext = {}): Promise<PersistentShellResult> {
    try {
      const command = args.command;
      if (typeof command !== 'string' || !command) return { success: false, error: 'Command parameter is required.' };

      const sessionId = args.sessionId || 'default';
      const reset = args.reset === true;
      const timeoutMs = args.timeoutMs || 30000;

      if (reset && sessions.has(sessionId)) {
        try { sessions.get(sessionId)?.process.kill('SIGTERM'); } catch { /* ignore */ }
        sessions.delete(sessionId);
      }

      let session = sessions.get(sessionId);
      if (!session) {
        const isWin = process.platform === 'win32';
        const shellBin = isWin ? 'powershell.exe' : (process.env.SHELL || '/bin/zsh');
        const shellArgs = isWin ? ['-NoLogo', '-NoExit', '-Command', '-'] : [];

        const initialCwd = typeof args.cwd === 'string' && args.cwd.trim()
          ? args.cwd.replace(/^~\//, os.homedir() + '/')
          : process.cwd();

        const proc = spawn(shellBin, shellArgs, {
          cwd: initialCwd,
          env: { ...getEnhancedEnv(), CAUSYNE_PERSISTENT_SHELL: '1', PS1: '' },
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true
        });

        proc.stdin.on('error', () => { /* ignore broken pipe */ });
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
      return await new Promise<PersistentShellResult>((resolve) => {
        const markerToken = `__CAUSYNE_PTY_DONE_${Date.now()}_${crypto.randomBytes(6).toString('hex')}__`;
        let outputBuffer = '';
        let errorBuffer = '';
        let isDone = false;

        const onData = (data: Buffer): void => {
          outputBuffer += data.toString('utf8');
          if (outputBuffer.includes(markerToken)) {
            finish();
          }
        };

        const onErrorData = (data: Buffer): void => {
          errorBuffer += data.toString('utf8');
        };

        const onExit = (): void => {
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

        const cleanupListeners = (): void => {
          activeSession.process.stdout.removeListener('data', onData);
          activeSession.process.stderr.removeListener('data', onErrorData);
          activeSession.process.removeListener('exit', onExit);
          clearTimeout(timer);
        };

        const finish = (): void => {
          if (isDone) return;
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
    } catch (e: unknown) {
      return { success: false, error: getErrorMessage(e) };
    }
  }
};
