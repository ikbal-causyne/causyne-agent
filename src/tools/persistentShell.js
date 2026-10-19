import { spawn } from 'child_process';
import os from 'os';
import path from 'path';

// Singleton map of active persistent shell sessions
const sessions = new Map();

export function cleanupPersistentShells() {
  for (const [id, session] of sessions.entries()) {
    try {
      session.process.kill('SIGTERM');
    } catch (e) {}
  }
  sessions.clear();
}

// Ensure cleanup on process exit
process.on('exit', cleanupPersistentShells);
process.on('SIGINT', () => { cleanupPersistentShells(); process.exit(); });
process.on('SIGTERM', () => { cleanupPersistentShells(); process.exit(); });

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

  async execute(args, context = {}) {
    try {
      const command = args.command;
      if (!command) return { success: false, error: 'Command parameter is required.' };

      const sessionId = args.sessionId || 'default';
      const reset = args.reset === true;
      const timeoutMs = args.timeoutMs || 30000;

      if (reset && sessions.has(sessionId)) {
        try { sessions.get(sessionId).process.kill('SIGTERM'); } catch (e) {}
        sessions.delete(sessionId);
      }

      let session = sessions.get(sessionId);
      if (!session) {
        const isWin = process.platform === 'win32';
        const shellBin = isWin ? 'powershell.exe' : (process.env.SHELL || '/bin/zsh');
        const shellArgs = isWin ? ['-NoLogo', '-NoExit', '-Command', '-'] : ['-l'];

        const proc = spawn(shellBin, shellArgs, {
          cwd: process.cwd(),
          env: { ...process.env, CAUSYNE_PERSISTENT_SHELL: '1', PS1: '' },
          stdio: ['pipe', 'pipe', 'pipe']
        });

        proc.on('error', (err) => {
          sessions.delete(sessionId);
        });

        proc.on('exit', () => {
          sessions.delete(sessionId);
        });

        session = {
          process: proc,
          currentCwd: process.cwd()
        };
        sessions.set(sessionId, session);
      }

      return new Promise((resolve) => {
        const markerToken = `__CAUSYNE_PTY_DONE_${Date.now()}_${Math.random().toString(36).substr(2, 6)}__`;
        let outputBuffer = '';
        let errorBuffer = '';
        let isDone = false;

        const onData = (data) => {
          const str = data.toString('utf8');
          outputBuffer += str;
          if (outputBuffer.includes(markerToken)) {
            finish();
          }
        };

        const onErrorData = (data) => {
          errorBuffer += data.toString('utf8');
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
          session.process.stdout.removeListener('data', onData);
          session.process.stderr.removeListener('data', onErrorData);
          clearTimeout(timer);
        };

        const finish = () => {
          if (isDone) return;
          isDone = true;
          cleanupListeners();

          // Clean marker token from output buffer
          const markerIndex = outputBuffer.indexOf(markerToken);
          let cleanOutput = markerIndex !== -1 ? outputBuffer.substring(0, markerIndex) : outputBuffer;
          cleanOutput = cleanOutput.replace(new RegExp(`echo\\s+"?${markerToken}"?`, 'g'), '').trim();

          // Try to query current cwd asynchronously for status info
          resolve({
            success: true,
            output: JSON.stringify({
              sessionId: sessionId,
              status: 'Executed cleanly in stateful session',
              stdout: cleanOutput || (errorBuffer ? '' : '[No output]'),
              stderr: errorBuffer.trim() || undefined
            }, null, 2)
          });
        };

        session.process.stdout.on('data', onData);
        session.process.stderr.on('data', onErrorData);

        // Send command followed by echo marker
        const isWin = process.platform === 'win32';
        const markerCmd = isWin ? `echo "${markerToken}"` : `echo "${markerToken}"`;
        session.process.stdin.write(`${command}\n${markerCmd}\n`);
      });
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
};
