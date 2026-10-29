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

export interface SysRunArgs {
  command: string;
  cwd?: string;
  timeout?: number;
}

export interface SysRunResult {
  success: boolean;
  output: string;
  error?: string | undefined;
  exitCode: number | null;
  running?: boolean;
  pid?: number;
  note?: string | undefined;
  cached?: boolean | undefined;
}

export interface SysRunContext {
  signal?: AbortSignal | undefined;
  skipCache?: boolean | undefined;
  parentLoop?: { currentTaskPrompt?: string; userPrompt?: string } | undefined;
}

export interface SysRunBgArgs {
  command: string;
  cwd?: string | undefined;
  label: string;
  maxDuration?: number | undefined;
}

export interface SysRunBgResult {
  success: boolean;
  output?: string | undefined;
  pid?: number | undefined;
  error?: string | undefined;
}

/**
 * Strips ANSI escape sequences and terminal control codes from string output.
 */
export function stripAnsi(str: string): string {
  const pattern = [
    '[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)',
    '(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))'
  ].join('|');
  return str.replace(new RegExp(pattern, 'g'), '');
}

/**
 * Strips ANSI escape sequences, normalizes carriage returns, and filters
 * transient progress meters (curl, wget) so agent history and split-panes never glitch.
 */
export function cleanSubprocessOutput(str: string): string {
  const normalized = stripAnsi(str)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');

  return normalized
    .split('\n')
    .filter(line => !/^\s*(?:%\s+Total\b|Dload\s+Upload\b|\d+\s+\d+(?:\.[0-9kKmM]+)?\s+\d+\s+.*--:--:--)/i.test(line))
    .join('\n');
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
export const IDEMPOTENT_COMMAND_PATTERN = /^(?!.*[;&|<>`$\r\n])(?:(?:python[0-9.]*|node|bun|npm|pnpm)\s+(?:-v|-V|--version)|pwd|(?:ls|cat|head|tail|grep|which|where|echo)(?:\s+[^;&|<>`$\r\n]+)?|git\s+(?:status|log|diff|show)(?:\s+[^;&|<>`$\r\n]+)?)$/;


/**
 * Detect long-running dev servers and web application listeners that must not block foreground loops.
 */
export function isPersistentServerCommand(cmd: string): boolean {
  if (!cmd || typeof cmd !== 'string') return false;
  const trimmed = cmd.trim();
  // A chained launch/check command must run through its actual final exit.
  // Returning at a readiness-looking line would skip later checks or failures.
  if (/[;&|<>`$\r\n]/.test(trimmed) || /^(?:cat|head|tail|grep|lsof|ps|kill|pkill|pgrep|curl|wget|echo|test)\b/i.test(trimmed)) {
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

export const SERVER_READY_PATTERN =
  /(?:https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):[0-9]+|serving\s+http\s+on|server\s+(?:running|started)|ready\s+in\s+[0-9]+|terra_server_running)/i;

interface CachedCommandResult {
  output: string;
  exitCode: number;
  success: boolean;
  note?: string | undefined;
  timestamp: number;
}

const COMMAND_CACHE_TTL_MS = 60_000;
const commandCache = new Map<string, CachedCommandResult>();

export function clearSysRunCache(): void {
  commandCache.clear();
}

export const sysRun = {
  schema: {
    name: 'sysRun',
    description:
      'Execute a shell command. CRITICAL CONSTRAINTS: 1. NEVER use interactive flags (like git rebase -i). 2. Always use non-interactive flags (--yes, -y). 3. If running git commit, always run git status, git diff, and git log first.',
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

  async execute(args: SysRunArgs, context: SysRunContext = {}): Promise<SysRunResult> {
    const rawCommand = (args?.command || '').trim();
    const cwd = args?.cwd ? args.cwd.replace(/^~\//, os.homedir() + '/') : process.cwd();
    const timeoutMs = args?.timeout || 60000;
    const signal = context.signal;

    // A foreground server waits forever for requests. Keep launch-only turns
    // responsive and make it explicit that starting is not a readiness check.
    const taskPrompt = context.parentLoop?.currentTaskPrompt || context.parentLoop?.userPrompt || '';
    if (isLaunchOnlyPrompt(taskPrompt) && !/[;&|<>`$\r\n]/.test(rawCommand) && isServerLaunchCommand(rawCommand)) {
      const started = await sysRunBg.execute({ command: rawCommand, cwd, label: 'local-server' });
      return started.success
        ? { success: true, output: `Started server process ${started.pid} in background. Readiness and browser opening have not been verified.`, exitCode: 0, note: 'Check the server URL before reporting it accessible.' }
        : { success: false, output: '', error: started.error || 'Unable to start server process.', exitCode: 1 };
    }

    // Fast-path: Return cached output for identical read-only idempotent commands
    const isIdempotent = IDEMPOTENT_COMMAND_PATTERN.test(rawCommand);
    if (!isIdempotent) commandCache.clear();
    const cacheKey = `${cwd}:::${rawCommand}`;

    if (!context.skipCache && isIdempotent && commandCache.has(cacheKey)) {
      const cached = commandCache.get(cacheKey)!;
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

    return new Promise<SysRunResult>((resolve) => {
      const shell = os.platform() === 'win32' ? 'cmd.exe' : '/bin/bash';
      const shellArgs = os.platform() === 'win32' ? ['/c', executedCommand] : ['-c', executedCommand];

      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(shell, shellArgs, { cwd, signal });
      } catch (err: unknown) {
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

      const checkServerDetach = (): void => {
        if (isDetached) return;
        if (isPersistentServerCommand(rawCommand)) {
          if (SERVER_READY_PATTERN.test(outputBuffer)) {
            isDetached = true;
            if (timeoutId) clearTimeout(timeoutId);
            if (serverGraceTimer) clearTimeout(serverGraceTimer);
            child.unref();
            resolve({
              success: true,
              output: cleanSubprocessOutput(outputBuffer),
              exitCode: null, running: true, ...(child.pid ? { pid: child.pid } : {}),
              note: 'The server reported startup. This process is still running; an independent readiness check is required.'
            });
          }
        }
      };

      const appendToBuffer = (data: Buffer | string): void => {
        outputBuffer += data.toString();
        if (outputBuffer.length > MAX_LENGTH) {
          outputBuffer = '...[OUTPUT TRUNCATED]...\n' + outputBuffer.slice(outputBuffer.length - MAX_LENGTH);
        }
        checkServerDetach();
      };

      child.stdout?.on('data', appendToBuffer);
      child.stderr?.on('data', appendToBuffer);

      let serverGraceTimer: NodeJS.Timeout | undefined;
      if (isPersistentServerCommand(rawCommand)) {
        serverGraceTimer = setTimeout(() => {
          if (!isDetached && child.exitCode === null) {
            isDetached = true;
            if (timeoutId) clearTimeout(timeoutId);
            child.unref();
            resolve({
              success: true,
              output: cleanSubprocessOutput(outputBuffer) || 'Server process started and running in background.',
              exitCode: null, running: true, ...(child.pid ? { pid: child.pid } : {}),
              note: 'The process is still running. No final exit status or readiness check is available.'
            });
          }
        }, 2500);
      }

      let timeoutId: NodeJS.Timeout | undefined;
      if (timeoutMs > 0) {
        timeoutId = setTimeout(() => {
          if (isDetached) return;
          if (serverGraceTimer) clearTimeout(serverGraceTimer);
          child.kill('SIGKILL');
          resolve({
            success: false,
            output: cleanSubprocessOutput(outputBuffer),
            error: `Process timed out after ${timeoutMs}ms`,
            exitCode: 124
          });
        }, timeoutMs);
      }

      child.on('error', (err: Error) => {
        if (isDetached) return;
        if (timeoutId) clearTimeout(timeoutId);
        if (serverGraceTimer) clearTimeout(serverGraceTimer);
        resolve({
          success: false,
          output: cleanSubprocessOutput(outputBuffer),
          error: err.message,
          exitCode: 1
        });
      });

      child.on('close', (code: number | null) => {
        if (isDetached) return;
        if (timeoutId) clearTimeout(timeoutId);
        if (serverGraceTimer) clearTimeout(serverGraceTimer);
        const cleanOutput = cleanSubprocessOutput(outputBuffer);
        const exitCode = typeof code === 'number' ? code : 1;

        if (exitCode === 0) {
          const res: SysRunResult = { success: true, output: cleanOutput, exitCode: 0 };
          if (isIdempotent) {
            commandCache.set(cacheKey, {
              output: cleanOutput,
              exitCode: 0,
              success: true,
              timestamp: Date.now()
            });
          }
          resolve(res);
        } else if (exitCode === 1 && !/[;&<>`$\r\n]/.test(rawCommand) && !rawCommand.includes('||')
          && /^(grep|egrep|fgrep|diff|test|which|cmp)\b/.test(rawCommand.split('|').at(-1)?.trim() || '')) {
          // Semantic Exit Code Normalization: POSIX search tool found 0 matching lines.
          const res: SysRunResult = {
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
        } else {
          if (signal && signal.aborted) {
            resolve({ success: false, output: cleanOutput, error: 'Process killed by user.', exitCode: 1 });
          } else {
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

  async execute(args: SysRunBgArgs): Promise<SysRunBgResult> {
    try {
      const cwd = args.cwd ? args.cwd.replace(/^~\//, os.homedir() + '/') : process.cwd();
      const shell = os.platform() === 'win32' ? 'cmd.exe' : '/bin/bash';
      const shellArgs = os.platform() === 'win32' ? ['/c', args.command] : ['-c', args.command];
      return await new Promise<SysRunBgResult>(resolve => {
        const child = spawn(shell, shellArgs, { cwd, detached: true, stdio: 'ignore' });
        child.once('error', error => resolve({ success: false, error: error.message }));
        child.once('spawn', () => {
          child.unref();
          resolve({ success: true, output: `Background process launched [${args.label}]; readiness not verified.`, pid: child.pid });
        });
      });
    } catch (e: unknown) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      return { success: false, error: errorMsg };
    }
  }
};
