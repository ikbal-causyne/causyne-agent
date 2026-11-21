import { spawn } from 'node:child_process';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { sanitizeSubprocessEnv } from '../tools/subprocessEnv.js';
function inside(root, candidate) {
    const lexicalRoot = path.resolve(root);
    const base = realpathSync(root);
    const lexical = path.relative(lexicalRoot, path.resolve(candidate));
    if (lexical === '..' || lexical.startsWith('..' + path.sep) || path.isAbsolute(lexical))
        return false;
    let target;
    try {
        target = realpathSync(candidate);
    }
    catch (error) {
        if (error?.code === 'ENOENT')
            return true;
        throw error;
    }
    const relative = path.relative(base, target);
    return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}
export async function runCliProbe(options = {}) {
    const safeOptions = options && typeof options === 'object' ? options : {};
    const { workspace, program, args = [], timeoutMs = 8_000, outputLimit = 32_768, expectedExitCode = 0, contains = null } = safeOptions;
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
    if (program !== 'node' && !path.isAbsolute(program)
        && !program.includes('/') && !program.includes('\\')) {
        throw new Error('Executable must be an explicit workspace path or node');
    }
    const executable = program === 'node' ? process.execPath : program;
    const resolvedProgram = path.isAbsolute(executable) ? executable
        : executable.includes('/') || executable.includes('\\') ? path.resolve(cwd, executable) : executable;
    if (!inside(cwd, cwd))
        throw new Error('Invalid workspace');
    if ((executable.includes('/') || executable.includes('\\')) && !inside(cwd, resolvedProgram)
        && resolvedProgram !== process.execPath) {
        throw new Error('Executable must remain inside workspace');
    }
    const started = Date.now();
    return new Promise(resolve => {
        let stdout = '';
        let stderr = '';
        let usedBytes = 0;
        let truncated = false;
        let timedOut = false;
        let exitCode = null;
        let signal = null;
        let spawnError = null;
        let settled = false;
        let child;
        let timer;
        const finish = () => {
            if (settled)
                return;
            settled = true;
            if (timer)
                clearTimeout(timer);
            const success = !timedOut && !spawnError && exitCode === expectedExitCode
                && !truncated && (contains === null || (stdout + stderr).includes(contains));
            resolve({
                status: success ? 'observed-pass' : 'observed-fail',
                success, command: { program: program, args, workspace: cwd },
                exitCode, signal, timedOut, truncated, stdout, stderr,
                error: spawnError, durationMs: Math.max(0, Date.now() - started),
                surface: 'cli-pipe',
                limitation: 'A pipe subprocess does not verify terminal rendering, mouse events, or desktop UI behavior'
            });
        };
        const collect = (field, chunk) => {
            const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
            const available = Math.max(0, outputLimit - usedBytes);
            if (data.length > available)
                truncated = true;
            if (available) {
                const safe = data.subarray(0, available).toString('utf8');
                if (field === 'stdout')
                    stdout += safe;
                else
                    stderr += safe;
                usedBytes += Math.min(available, data.length);
            }
        };
        try {
            child = spawn(resolvedProgram, args, {
                cwd, shell: false, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
                env: { ...sanitizeSubprocessEnv(process.env), CAUSYNE_VERIFY_PROBE: '1' }
            });
            child.stdout?.on('data', (chunk) => collect('stdout', chunk));
            child.stderr?.on('data', (chunk) => collect('stderr', chunk));
            child.on('error', (error) => { spawnError = String(error.message || error); finish(); });
            child.on('close', (code, sig) => {
                exitCode = code;
                signal = sig;
                finish();
            });
            timer = setTimeout(() => {
                timedOut = true;
                child?.kill('SIGKILL');
            }, timeoutMs);
            timer.unref?.();
        }
        catch (error) {
            spawnError = error instanceof Error ? error.message : String(error);
            finish();
        }
    });
}
