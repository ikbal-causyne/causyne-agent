import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { causyneHome, resolveUserPath } from '../utils/paths.js';
import { filmEngine } from './film.js';
const MAX_STDOUT = 8 * 1024 * 1024;
const MAX_STDERR = 1024 * 1024;
export const NATIVE_ENGINES = {
    [filmEngine.id]: filmEngine
};
export function nativeEngine(id) {
    return NATIVE_ENGINES[id] ?? null;
}
export function engineInstallDir(adapter) {
    return path.join(causyneHome(), 'engines', adapter.id);
}
function inside(root, target) {
    const relative = path.relative(root, target);
    return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function currentEngineBinary(adapter) {
    const root = engineInstallDir(adapter);
    const suffix = process.platform === 'win32' ? '.exe' : '';
    try {
        const value = JSON.parse(fs.readFileSync(path.join(root, 'current.json'), 'utf8'));
        if (typeof value.version !== 'string' || !/^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/.test(value.version))
            return null;
        if (typeof value.platform !== 'string' || !/^[a-z0-9]+-[a-z0-9]+$/.test(value.platform))
            return null;
        const file = path.join(root, 'versions', value.version, value.platform, `${adapter.binaryName}${suffix}`);
        return inside(root, file) ? file : null;
    }
    catch {
        return null;
    }
}
export function engineBinaryCandidates(adapter) {
    const suffix = process.platform === 'win32' ? '.exe' : '';
    const name = `${adapter.binaryName}${suffix}`;
    const root = engineInstallDir(adapter);
    return [
        path.join(root, 'current', 'bin', name),
        path.join(root, 'current', name),
        path.join(root, 'bin', name),
        path.join(root, name)
    ];
}
function executable(file) {
    try {
        if (!fs.statSync(file).isFile())
            return false;
        fs.accessSync(file, fs.constants.X_OK);
        return true;
    }
    catch {
        return false;
    }
}
export function findEngineBinary(adapter) {
    const override = process.env[adapter.envVar];
    if (override && override.trim()) {
        const candidate = resolveUserPath(override.trim());
        const file = (() => {
            try {
                return fs.statSync(candidate).isDirectory();
            }
            catch {
                return false;
            }
        })() ? path.join(candidate, adapter.binaryName + (process.platform === 'win32' ? '.exe' : '')) : candidate;
        if (executable(file))
            return fs.realpathSync(file);
    }
    const current = currentEngineBinary(adapter);
    if (current && executable(current))
        return fs.realpathSync(current);
    for (const candidate of engineBinaryCandidates(adapter)) {
        if (executable(candidate))
            return fs.realpathSync(candidate);
    }
    return null;
}
function childEnv() {
    const keys = [
        'PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR',
        'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME'
    ];
    const env = {};
    for (const key of keys) {
        const value = process.env[key];
        if (value !== undefined)
            env[key] = value;
    }
    env.NO_COLOR = '1';
    return env;
}
export function runEngineBinary(binary, args, options) {
    options.signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
        const child = spawn(binary, args, {
            cwd: options.cwd,
            env: childEnv(),
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            ...(options.signal ? { signal: options.signal } : {})
        });
        let stdout = '';
        let stderr = '';
        let settled = false;
        let timer;
        const finish = (run) => {
            if (settled)
                return;
            settled = true;
            if (timer)
                clearTimeout(timer);
            resolve(run);
        };
        const fail = (error) => {
            if (settled)
                return;
            settled = true;
            if (timer)
                clearTimeout(timer);
            reject(error);
        };
        child.stdout.on('data', (chunk) => {
            if (stdout.length + chunk.length > MAX_STDOUT) {
                child.kill('SIGKILL');
                stderr += '\nEngine output exceeded the 8 MB limit.';
                return;
            }
            stdout += chunk.toString('utf8');
        });
        child.stderr.on('data', (chunk) => {
            if (stderr.length < MAX_STDERR)
                stderr += chunk.toString('utf8');
        });
        child.on('error', fail);
        if (options.stdin !== undefined) {
            child.stdin.on('error', () => { });
            child.stdin.end(options.stdin);
        }
        else {
            child.stdin.end();
        }
        child.on('close', (code, signal) => {
            const exitCode = typeof code === 'number' ? code : signal ? 1 : 0;
            if (stderr.length > MAX_STDERR)
                stderr = stderr.slice(0, MAX_STDERR) + '\n...(stderr truncated)';
            finish({ exitCode, stdout, stderr });
        });
        timer = setTimeout(() => {
            stderr += `\nEngine timed out after ${options.timeoutMs} ms.`;
            child.kill('SIGKILL');
        }, options.timeoutMs);
    });
}
export async function engineVersion(binary, workspace, signal) {
    const run = await runEngineBinary(binary, ['--version'], { cwd: workspace, timeoutMs: 10_000, ...(signal ? { signal } : {}) });
    const match = run.stdout.match(/\b(\d+\.\d+(?:\.\d+)?)\b/);
    return match?.[1] ?? null;
}
