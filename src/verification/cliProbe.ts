import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { realpathSync, statSync } from 'node:fs';
import { sanitizeSubprocessEnv } from '../tools/subprocessEnv.js';
import { isBlockedWorkspaceRoot } from '../sandboxPolicy.js';
import { redactProviderSecrets } from '../providers/byokHttp.js';

export interface CliProbeOptions {
  workspace?: string;
  program?: string;
  args?: string[];
  timeoutMs?: number;
  outputLimit?: number;
  expectedExitCode?: number;
  contains?: string | null;
}

export interface CliProbeResult {
  status: 'observed-pass' | 'observed-fail';
  success: boolean;
  command: { program: string; args: string[]; workspace: string };
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  truncated: boolean;
  stdout: string;
  stderr: string;
  error: string | null;
  durationMs: number;
  surface: 'cli-pipe';
  limitation: string;
}

function inside(root: string, candidate: string): boolean {
  if (root.includes('\0') || candidate.includes('\0')) return false;
  const lexicalRoot = path.resolve(root);
  const base = realpathSync(root);
  const lexical = path.relative(lexicalRoot, path.resolve(candidate));
  if (lexical === '..' || lexical.startsWith('..' + path.sep) || path.isAbsolute(lexical)) return false;
  let target: string;
  try {
    target = realpathSync(candidate);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return true;
    throw error;
  }
  const relative = path.relative(base, target);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

export async function runCliProbe(options: CliProbeOptions = {}): Promise<CliProbeResult> {
  const safeOptions = options && typeof options === 'object' ? options : {};
  const {
    workspace,
    program,
    args = [],
    timeoutMs = 8_000,
    outputLimit = 32_768,
    expectedExitCode = 0,
    contains = null
  } = safeOptions;
  if (typeof workspace !== 'string' || workspace.includes('\0')
      || typeof program !== 'string' || program.includes('\0')
      || !Array.isArray(args) || !args.every(a => typeof a === 'string' && !a.includes('\0'))) {
    throw new TypeError('workspace, program, and string argv are required');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 60_000) {
    throw new RangeError('timeoutMs must be between 10 and 60000');
  }
  if (!Number.isSafeInteger(outputLimit) || outputLimit < 64 || outputLimit > 1_048_576) {
    throw new RangeError('outputLimit must be between 64 and 1048576');
  }
  if (!Number.isInteger(expectedExitCode) || expectedExitCode < 0 || expectedExitCode > 255) {
    throw new RangeError('invalid expectedExitCode');
  }
  if (contains !== null && (typeof contains !== 'string' || contains.length > 1000)) {
    throw new TypeError('contains must be a bounded string');
  }
  const cwd = path.resolve(workspace);
  if (isBlockedWorkspaceRoot(cwd)) throw new Error('Workspace cannot be a protected system root');
  if (program !== 'node' && !path.isAbsolute(program)
      && !program.includes('/') && !program.includes('\\')) {
    throw new Error('Executable must be an explicit workspace path or node');
  }
  const executable = program === 'node' ? process.execPath : program;
  const resolvedProgram = path.isAbsolute(executable) ? executable
    : executable.includes('/') || executable.includes('\\') ? path.resolve(cwd, executable) : executable;
  if (!inside(cwd, cwd)) throw new Error('Invalid workspace');
  if ((executable.includes('/') || executable.includes('\\')) && !inside(cwd, resolvedProgram)
      && resolvedProgram !== process.execPath) {
    throw new Error('Executable must remain inside workspace');
  }
  if (resolvedProgram !== process.execPath) {
    try {
      if (!statSync(resolvedProgram).isFile()) {
        throw new Error('Executable must be a regular file');
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    }
  }

  const started = Date.now();
  return new Promise<CliProbeResult>(resolve => {
    const stdoutDecoder = new StringDecoder('utf8');
    const stderrDecoder = new StringDecoder('utf8');
    let stdout = '';
    let stderr = '';
    let usedBytes = 0;
    let truncated = false;
    let timedOut = false;
    let exitCode: number | null = null;
    let signal: NodeJS.Signals | null = null;
    let spawnError: string | null = null;
    let settled = false;
    let child: ChildProcess | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      const success = !timedOut && !spawnError && exitCode === expectedExitCode
        && !truncated && (contains === null || (stdout + stderr).includes(contains));
      resolve({
        status: success ? 'observed-pass' : 'observed-fail',
        success, command: { program: program!, args, workspace: cwd },
        exitCode, signal, timedOut, truncated, stdout, stderr,
        error: spawnError ? redactProviderSecrets(spawnError).slice(0, 512) : null, durationMs: Math.max(0, Date.now() - started),
        surface: 'cli-pipe',
        limitation: 'A pipe subprocess does not verify terminal rendering, mouse events, or desktop UI behavior'
      });
    };
    const collect = (field: 'stdout' | 'stderr', chunk: Buffer | string): void => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const available = Math.max(0, outputLimit - usedBytes);
      if (data.length > available) truncated = true;
      if (available) {
        const slice = data.subarray(0, available);
        if (field === 'stdout') stdout += stdoutDecoder.write(slice);
        else stderr += stderrDecoder.write(slice);
        usedBytes += slice.length;
      }
    };
    try {
      child = spawn(resolvedProgram, args, {
        cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
        env: { ...sanitizeSubprocessEnv(process.env), CAUSYNE_VERIFY_PROBE: '1' }
      });
      child.stdout?.on('data', (chunk: Buffer) => collect('stdout', chunk));
      child.stderr?.on('data', (chunk: Buffer) => collect('stderr', chunk));
      child.on('error', (error: Error) => { spawnError = String(error.message || error); finish(); });
      child.on('close', (code: number | null, sig: NodeJS.Signals | null) => {
        exitCode = code;
        signal = sig;
        finish();
      });
      timer = setTimeout(() => {
        timedOut = true;
        try { child?.kill('SIGKILL'); } catch { /* process already exited */ }
      }, timeoutMs);
      timer.unref?.();
    } catch (error: unknown) {
      spawnError = error instanceof Error ? error.message : String(error);
      finish();
    }
  });
}
