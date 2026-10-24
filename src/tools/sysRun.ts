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

export interface SysRunArgs {
  command: string;
  cwd?: string;
  timeout?: number;
}

export interface SysRunResult {
  success: boolean;
  output: string;
  error?: string | undefined;
  exitCode: number;
  note?: string | undefined;
  cached?: boolean | undefined;
}

export interface SysRunContext {
  signal?: AbortSignal | undefined;
  skipCache?: boolean | undefined;
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
 * Commands whose exit code 1 indicates a normal query result (e.g. no matches found,
 * differences found, or condition evaluated to false) rather than a system error.
 */
export const SEARCH_COMMAND_PATTERN = /(^|\s|\||&&|;)(grep|egrep|fgrep|diff|test|which|cmp|find)(\s|$)/;

/**
 * Commands that are strictly read-only and idempotent.
 * Repeated identical executions within a short TTL window return cached output.
 */
export const IDEMPOTENT_COMMAND_PATTERN =
  /^(python3?|node|bun|pnpm|npm)\s+(-v|--version|(-c|-e)\s+["'].*?["'])$|^ls\b|^cat\b|^head\b|^tail\b|^grep\b|^find\b|^which\b|^where\b|^pwd$|^git\s+(status|log|diff|branch|tag|show\b)|^echo\b/;

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

    // Fast-path: Return cached output for identical read-only idempotent commands
    const isIdempotent = IDEMPOTENT_COMMAND_PATTERN.test(rawCommand);
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

    return new Promise<SysRunResult>((resolve) => {
      const shell = os.platform() === 'win32' ? 'cmd.exe' : '/bin/bash';
      const shellArgs = os.platform() === 'win32' ? ['/c', rawCommand] : ['-c', rawCommand];

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

      const appendToBuffer = (data: Buffer | string): void => {
        outputBuffer += data.toString();
        if (outputBuffer.length > MAX_LENGTH) {
          outputBuffer = '...[OUTPUT TRUNCATED]...\n' + outputBuffer.slice(outputBuffer.length - MAX_LENGTH);
        }
      };

      child.stdout?.on('data', appendToBuffer);
      child.stderr?.on('data', appendToBuffer);

      let timeoutId: NodeJS.Timeout | undefined;
      if (timeoutMs > 0) {
        timeoutId = setTimeout(() => {
          child.kill('SIGKILL');
          resolve({
            success: false,
            output: stripAnsi(outputBuffer),
            error: `Process timed out after ${timeoutMs}ms`,
            exitCode: 124
          });
        }, timeoutMs);
      }

      child.on('error', (err: Error) => {
        if (timeoutId) clearTimeout(timeoutId);
        resolve({
          success: false,
          output: stripAnsi(outputBuffer),
          error: err.message,
          exitCode: 1
        });
      });

      child.on('close', (code: number | null) => {
        if (timeoutId) clearTimeout(timeoutId);
        const cleanOutput = stripAnsi(outputBuffer);
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
        } else if (exitCode === 1 && SEARCH_COMMAND_PATTERN.test(rawCommand)) {
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

      const child = spawn(shell, shellArgs, {
        cwd,
        detached: true,
        stdio: 'ignore'
      });

      child.unref();

      return {
        success: true,
        output: `Successfully started background task [${args.label}]: ${args.command}`,
        pid: child.pid
      };
    } catch (e: unknown) {
      const errorMsg = e instanceof Error ? e.message : String(e);
      return { success: false, error: errorMsg };
    }
  }
};
