/**
 * Causyne Agent — OS-Level Process Sandboxing Wrapper (Sector 2B)
 *
 * Provides kernel-enforced filesystem & network isolation around shell tool
 * subprocesses when enabled via `CAUSYNE_OS_SANDBOX` or `config.osSandbox`:
 *   - macOS (`darwin`): Apple Seatbelt (`/usr/bin/sandbox-exec -p <SBPL>`)
 *   - Linux (`linux`):  Bubblewrap (`bwrap`) mount/network namespaces
 *   - Windows / nested containers: honest capability reporting (`backend: 'none'`)
 *     with fail-closed enforcement when `strict` mode is explicitly requested.
 *
 * Complements application-level `Sandbox` classification and `sanitizeSubprocessEnv`
 * without ever stripping or degrading peer ACP capabilities.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sanitizeSubprocessEnv } from './subprocessEnv.js';
const SEATBELT_BIN = '/usr/bin/sandbox-exec';
const CREDENTIAL_SUBPATHS = [
    '.ssh',
    '.aws',
    '.gnupg',
    '.kube',
    '.causyne',
    '.netrc',
    '.git-credentials',
    '.pypirc',
    '.npmrc',
    '.docker/config.json',
    '.config/gh',
    '.config/gcloud',
    '.azure',
    '.terraform.d',
    '.vault-token',
    'Library/Keychains'
];
const SHELL_PERSISTENCE_FILES = [
    '.bashrc',
    '.bash_profile',
    '.bash_login',
    '.profile',
    '.zshrc',
    '.zprofile',
    '.zshenv',
    '.zlogin',
    '.config/fish/config.fish'
];
const DEV_CACHE_SUBPATHS = [
    '.npm',
    '.cache',
    '.cargo',
    '.rustup',
    '.gradle',
    '.m2',
    'go/pkg',
    'Library/Caches'
];
let cachedProbe = null;
/**
 * Escapes a filesystem path for safe embedding in an Apple Seatbelt SBPL string.
 * Rejects control characters and NUL bytes to prevent S-expression injection.
 */
export function escapeSeatbeltPath(rawPath) {
    if (typeof rawPath !== 'string' || rawPath.length === 0)
        return null;
    for (let i = 0; i < rawPath.length; i++) {
        const code = rawPath.charCodeAt(i);
        if (code < 0x20 || code === 0x7f)
            return null;
    }
    return rawPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}
function resolveCanonicalPaths(rawPath) {
    if (typeof rawPath !== 'string' || rawPath.length === 0 || rawPath.includes('\0')) {
        return [];
    }
    const resolved = path.resolve(rawPath);
    const out = new Set();
    try {
        const real = fs.realpathSync.native(resolved);
        out.add(real);
    }
    catch {
        // Walk up to nearest existing ancestor so symlinked prefixes (e.g. /var -> /private/var) resolve
        let current = resolved;
        const tail = [];
        for (let depth = 0; depth < 64; depth++) {
            const parent = path.dirname(current);
            if (parent === current)
                break;
            tail.unshift(path.basename(current));
            current = parent;
            try {
                const realAncestor = fs.realpathSync.native(current);
                out.add(path.resolve(realAncestor, ...tail));
                break;
            }
            catch {
                continue;
            }
        }
    }
    out.add(resolved);
    return [...out];
}
function resolveWorktreeGitDirs(workspacePath) {
    const dirs = [];
    try {
        const dotGit = path.join(path.resolve(workspacePath), '.git');
        const stat = fs.lstatSync(dotGit);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.size === 0 || stat.size > 4096) {
            return dirs;
        }
        const raw = fs.readFileSync(dotGit, 'utf8').trim();
        if (!raw.toLowerCase().startsWith('gitdir:'))
            return dirs;
        const rawTarget = raw.slice('gitdir:'.length).trim();
        if (!rawTarget || rawTarget.includes('\0'))
            return dirs;
        const resolvedGitDir = path.isAbsolute(rawTarget)
            ? path.resolve(rawTarget)
            : path.resolve(path.dirname(dotGit), rawTarget);
        const gitDirStat = fs.lstatSync(resolvedGitDir);
        if (!gitDirStat.isSymbolicLink() && gitDirStat.isDirectory()) {
            dirs.push(resolvedGitDir);
            // Also allow the common parent .git directory when referenced via commondir
            const commonDirFile = path.join(resolvedGitDir, 'commondir');
            try {
                const cStat = fs.lstatSync(commonDirFile);
                if (!cStat.isSymbolicLink() && cStat.isFile() && cStat.size > 0 && cStat.size <= 4096) {
                    const commonRel = fs.readFileSync(commonDirFile, 'utf8').trim();
                    if (commonRel && !commonRel.includes('\0')) {
                        const commonAbs = path.isAbsolute(commonRel)
                            ? path.resolve(commonRel)
                            : path.resolve(resolvedGitDir, commonRel);
                        if (!fs.lstatSync(commonAbs).isSymbolicLink() && fs.statSync(commonAbs).isDirectory()) {
                            dirs.push(commonAbs);
                        }
                    }
                }
            }
            catch { /* ignore absent commondir */ }
        }
    }
    catch {
        // Workspace is not a linked git worktree
    }
    return dirs;
}
function isSameOrChildPath(candidate, parent) {
    const rel = path.relative(parent, candidate);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}
function workspaceOverlapsPath(workspacePaths, targetPath) {
    const targetVariants = resolveCanonicalPaths(targetPath);
    for (const ws of workspacePaths) {
        const wsVariants = resolveCanonicalPaths(ws);
        for (const wv of wsVariants) {
            for (const tv of targetVariants) {
                if (isSameOrChildPath(wv, tv))
                    return true;
            }
        }
    }
    return false;
}
/**
 * Parses `CAUSYNE_OS_SANDBOX` / `config.osSandbox` into an explicit OS sandbox mode.
 * Defaults to `'workspace-write'` (best-effort kernel boundary with workspace and temp writes)
 * when unset so fresh installs are protected by default; explicit `'off'`/`'0'`/`'false'`/`'disabled'`
 * disables wrapping.
 */
export function resolveOsSandboxMode(env = process.env, configMode) {
    const safeEnv = env && typeof env === 'object' ? env : {};
    const envSandbox = Object.hasOwn(safeEnv, 'CAUSYNE_OS_SANDBOX') ? safeEnv.CAUSYNE_OS_SANDBOX : undefined;
    const raw = (typeof envSandbox === 'string' && envSandbox.trim())
        ? envSandbox.trim()
        : (typeof configMode === 'string' ? configMode.trim() : '');
    const lower = raw.toLowerCase();
    const envNetwork = Object.hasOwn(safeEnv, 'CAUSYNE_OS_SANDBOX_NETWORK') ? safeEnv.CAUSYNE_OS_SANDBOX_NETWORK : undefined;
    const networkEnv = typeof envNetwork === 'string'
        ? envNetwork.trim().toLowerCase()
        : '';
    const allowNetwork = !(networkEnv === '0' || networkEnv === 'false' || networkEnv === 'off' || networkEnv === 'deny');
    if (!lower) {
        return { mode: 'workspace-write', strict: false, allowNetwork };
    }
    if (lower === 'off' || lower === '0' || lower === 'false' || lower === 'disabled') {
        return { mode: 'off', strict: false, allowNetwork };
    }
    if (lower === 'read-only' || lower === 'readonly' || lower === 'ro') {
        return { mode: 'read-only', strict: false, allowNetwork };
    }
    if (lower === 'read-only-strict') {
        return { mode: 'read-only', strict: true, allowNetwork };
    }
    if (lower === 'strict') {
        return { mode: 'workspace-write', strict: true, allowNetwork };
    }
    if (lower === 'workspace-write' || lower === 'on' || lower === '1' || lower === 'true' || lower === 'auto') {
        return { mode: 'workspace-write', strict: false, allowNetwork };
    }
    return { mode: 'off', strict: false, allowNetwork };
}
function findExecutableInPath(binaryName, env = process.env) {
    if (typeof binaryName !== 'string' || binaryName.length === 0 || binaryName.includes('\0') || binaryName.includes('/') || binaryName.includes('\\')) {
        return null;
    }
    const pathVal = (env && typeof env.PATH === 'string') ? env.PATH : '';
    for (const dir of pathVal.split(path.delimiter)) {
        if (!dir || dir.includes('\0') || !path.isAbsolute(dir))
            continue;
        const candidate = path.join(dir, binaryName);
        try {
            fs.accessSync(candidate, fs.constants.X_OK);
            if (fs.statSync(candidate).isFile())
                return candidate;
        }
        catch {
            continue;
        }
    }
    return null;
}
/**
 * Probes whether an OS-level kernel sandbox backend is installed and functional
 * (not blocked by a nested container or restricted user namespace).
 */
export function probeOsSandbox(options) {
    const platform = options?.platform ?? process.platform;
    if (!options?.bypassCache && cachedProbe && cachedProbe.platform === platform) {
        return cachedProbe.result;
    }
    let result;
    if (platform === 'darwin') {
        if (!fs.existsSync(SEATBELT_BIN)) {
            result = {
                backend: 'none',
                platform,
                available: false,
                supportsFilesystemIsolation: false,
                supportsNetworkIsolation: false,
                binaryPath: null,
                reason: 'macOS sandbox-exec binary not found.'
            };
        }
        else {
            const check = spawnSync(SEATBELT_BIN, ['-p', '(version 1)(allow default)', '/usr/bin/true'], {
                stdio: 'ignore',
                timeout: 3000,
                windowsHide: true,
                env: sanitizeSubprocessEnv(process.env)
            });
            if (check.status === 0) {
                result = {
                    backend: 'seatbelt',
                    platform,
                    available: true,
                    supportsFilesystemIsolation: true,
                    supportsNetworkIsolation: true,
                    binaryPath: SEATBELT_BIN,
                    reason: 'macOS Seatbelt (sandbox-exec) active and verified.'
                };
            }
            else {
                result = {
                    backend: 'none',
                    platform,
                    available: false,
                    supportsFilesystemIsolation: false,
                    supportsNetworkIsolation: false,
                    binaryPath: SEATBELT_BIN,
                    reason: 'macOS Seatbelt cannot apply in this environment (likely nested sandbox).'
                };
            }
        }
    }
    else if (platform === 'linux') {
        const bwrapPath = findExecutableInPath('bwrap');
        if (!bwrapPath) {
            result = {
                backend: 'none',
                platform,
                available: false,
                supportsFilesystemIsolation: false,
                supportsNetworkIsolation: false,
                binaryPath: null,
                reason: 'Linux bubblewrap (bwrap) is not installed.'
            };
        }
        else {
            const check = spawnSync(bwrapPath, ['--unshare-pid', '--unshare-ipc', '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '/bin/true'], {
                stdio: 'ignore',
                timeout: 3000,
                windowsHide: true,
                env: sanitizeSubprocessEnv(process.env)
            });
            if (check.status === 0) {
                result = {
                    backend: 'bubblewrap',
                    platform,
                    available: true,
                    supportsFilesystemIsolation: true,
                    supportsNetworkIsolation: true,
                    binaryPath: bwrapPath,
                    reason: 'Linux bubblewrap (bwrap) namespaces active and verified.'
                };
            }
            else {
                result = {
                    backend: 'none',
                    platform,
                    available: false,
                    supportsFilesystemIsolation: false,
                    supportsNetworkIsolation: false,
                    binaryPath: bwrapPath,
                    reason: 'Linux bubblewrap (bwrap) unavailable (user namespaces disabled in container).'
                };
            }
        }
    }
    else {
        result = {
            backend: 'none',
            platform,
            available: false,
            supportsFilesystemIsolation: false,
            supportsNetworkIsolation: false,
            binaryPath: null,
            reason: `Kernel subprocess sandboxing is not implemented for platform "${platform}"; application sandbox and env isolation remain active.`
        };
    }
    if (!options?.bypassCache) {
        cachedProbe = { platform, result };
    }
    return result;
}
/**
 * Generates an Apple Seatbelt SBPL profile for macOS `sandbox-exec`.
 * Uses Seatbelt's last-match-wins semantics:
 *   1. Allow default reads/exec of system libraries & toolchains.
 *   2. Optionally deny remote outbound IP connections (`allowNetwork === false`).
 *   3. Deny all `file-write*`, then allow only safe device nodes, workspace roots,
 *      temp dirs, and standard dev caches (in `workspace-write` mode).
 *   4. Explicitly deny `file-write*` on shell startup profiles and credential vaults.
 *   5. Explicitly deny `file-read*` on credential vaults (unless the user explicitly
 *      selected that directory as their workspace).
 */
export function buildSeatbeltProfile(options) {
    if (!options || typeof options !== 'object' || typeof options.cwd !== 'string' || !options.cwd.trim() || options.cwd.includes('\0')) {
        throw new TypeError('buildSeatbeltProfile requires a valid cwd');
    }
    const mode = options.mode ?? 'workspace-write';
    const homeDir = options.homeDir ?? os.homedir();
    const tmpDir = options.tmpDir ?? os.tmpdir();
    const configuredWorkspaces = (options.workspaceRoots ?? [])
        .filter((entry) => typeof entry === 'string' && entry.trim().length > 0 && !entry.includes('\0'));
    const workspaces = configuredWorkspaces.length > 0 ? configuredWorkspaces : [options.cwd];
    const lines = [
        '(version 1)',
        '(allow default)'
    ];
    if (options.allowNetwork === false) {
        lines.push('(deny network-outbound (remote ip))');
        // Preserve loopback access so local dev/test servers and local Ollama remain reachable
        lines.push('(allow network-outbound (remote ip "localhost:*"))');
    }
    lines.push('(deny file-write*)');
    // Always allow writing to standard harmless device sinks
    const safeDeviceLiterals = [
        '/dev/null',
        '/dev/zero',
        '/dev/tty',
        '/dev/ptmx',
        '/dev/dtracehelper',
        '/dev/stdout',
        '/dev/stderr'
    ];
    lines.push(`(allow file-write* ${safeDeviceLiterals.map(p => `(literal "${p}")`).join(' ')})`);
    if (mode === 'workspace-write') {
        const writableSubpaths = new Set();
        const addWritable = (rawPath) => {
            for (const variant of resolveCanonicalPaths(rawPath)) {
                const escaped = escapeSeatbeltPath(variant);
                if (escaped)
                    writableSubpaths.add(escaped);
            }
        };
        for (const ws of workspaces) {
            addWritable(ws);
            for (const gitDir of resolveWorktreeGitDirs(ws)) {
                addWritable(gitDir);
            }
        }
        if (options.includeTempDirs !== false) {
            for (const t of ['/tmp', '/private/tmp', '/private/var/tmp', '/private/var/folders', tmpDir]) {
                if (t)
                    addWritable(t);
            }
        }
        if (options.allowDevCaches !== false && homeDir) {
            for (const rel of DEV_CACHE_SUBPATHS) {
                addWritable(path.join(homeDir, rel));
            }
        }
        if (writableSubpaths.size > 0) {
            const clauses = [...writableSubpaths].map(p => `(subpath "${p}")`).join(' ');
            lines.push(`(allow file-write* ${clauses})`);
        }
    }
    // Last-match-wins: shell startup persistence targets remain strictly unwritable
    if (homeDir) {
        const denyWriteLiterals = new Set();
        for (const rel of SHELL_PERSISTENCE_FILES) {
            const full = path.join(homeDir, rel);
            for (const variant of resolveCanonicalPaths(full)) {
                const escaped = escapeSeatbeltPath(variant);
                if (escaped)
                    denyWriteLiterals.add(escaped);
            }
        }
        if (denyWriteLiterals.size > 0) {
            lines.push(`(deny file-write* ${[...denyWriteLiterals].map(p => `(literal "${p}")`).join(' ')})`);
        }
    }
    // Last-match-wins: credential vaults denied for both read and write unless explicitly chosen as workspace
    const denyCredSubpaths = new Set();
    if (homeDir) {
        for (const rel of CREDENTIAL_SUBPATHS) {
            const full = path.join(homeDir, rel);
            if (workspaceOverlapsPath(workspaces, full))
                continue;
            for (const variant of resolveCanonicalPaths(full)) {
                const escaped = escapeSeatbeltPath(variant);
                if (escaped)
                    denyCredSubpaths.add(escaped);
            }
        }
    }
    if (Array.isArray(options.extraDenyReadPaths)) {
        for (const extra of options.extraDenyReadPaths) {
            for (const variant of resolveCanonicalPaths(extra)) {
                const escaped = escapeSeatbeltPath(variant);
                if (escaped)
                    denyCredSubpaths.add(escaped);
            }
        }
    }
    if (denyCredSubpaths.size > 0) {
        const clauses = [...denyCredSubpaths].map(p => `(subpath "${p}")`).join(' ');
        lines.push(`(deny file-read* ${clauses})`);
        lines.push(`(deny file-write* ${clauses})`);
    }
    return `${lines.join('\n')}\n`;
}
/**
 * Generates shell-free argv for Linux `bwrap` (bubblewrap) isolation.
 */
export function buildBubblewrapArgs(shell, shellArgs, options) {
    if (!options || typeof options !== 'object' || typeof options.cwd !== 'string' || !options.cwd.trim() || options.cwd.includes('\0')) {
        throw new TypeError('buildBubblewrapArgs requires a valid cwd');
    }
    if (typeof shell !== 'string' || !shell.trim() || shell.includes('\0')) {
        throw new TypeError('buildBubblewrapArgs requires a valid shell');
    }
    if (!Array.isArray(shellArgs) || shellArgs.some(arg => typeof arg !== 'string' || arg.includes('\0'))) {
        throw new TypeError('buildBubblewrapArgs requires valid shellArgs');
    }
    const mode = options.mode ?? 'workspace-write';
    const homeDir = options.homeDir ?? os.homedir();
    const configuredWorkspaces = (options.workspaceRoots ?? [])
        .filter((entry) => typeof entry === 'string' && entry.trim().length > 0);
    const workspaces = configuredWorkspaces.length > 0 ? configuredWorkspaces : [options.cwd];
    const args = [
        '--die-with-parent',
        '--unshare-pid',
        '--unshare-ipc',
        '--ro-bind', '/', '/',
        '--dev', '/dev',
        '--proc', '/proc'
    ];
    if (options.includeTempDirs !== false) {
        args.push('--tmpfs', '/tmp');
    }
    if (options.allowNetwork === false) {
        args.push('--unshare-net');
    }
    if (mode === 'workspace-write') {
        const bound = new Set();
        const bindIfExists = (rawPath) => {
            const resolved = path.resolve(rawPath);
            if (bound.has(resolved))
                return;
            if (!fs.existsSync(resolved))
                return;
            bound.add(resolved);
            args.push('--bind', resolved, resolved);
        };
        for (const ws of workspaces) {
            bindIfExists(ws);
            for (const variant of resolveCanonicalPaths(ws)) {
                bindIfExists(variant);
            }
            for (const gitDir of resolveWorktreeGitDirs(ws)) {
                bindIfExists(gitDir);
            }
        }
        if (options.allowDevCaches !== false && homeDir) {
            for (const rel of DEV_CACHE_SUBPATHS) {
                bindIfExists(path.join(homeDir, rel));
            }
        }
    }
    else if (mode === 'read-only' && options.includeTempDirs !== false) {
        const roBound = new Set();
        const roBindTmpPath = (rawPath) => {
            const resolved = path.resolve(rawPath);
            if (roBound.has(resolved))
                return;
            if (!isSameOrChildPath(resolved, '/tmp'))
                return;
            if (!fs.existsSync(resolved))
                return;
            roBound.add(resolved);
            args.push('--ro-bind', resolved, resolved);
        };
        for (const ws of workspaces) {
            roBindTmpPath(ws);
        }
        roBindTmpPath(options.cwd);
    }
    // Mask existing credential vaults (directories & files) and extra deny paths unless inside selected workspace
    const masked = new Set();
    const maskTarget = (rawPath) => {
        for (const variant of resolveCanonicalPaths(rawPath)) {
            if (masked.has(variant))
                continue;
            try {
                const lstat = fs.lstatSync(variant);
                if (lstat.isSymbolicLink()) {
                    let targetIsDir = false;
                    try {
                        targetIsDir = fs.statSync(variant).isDirectory();
                    }
                    catch {
                        targetIsDir = false;
                    }
                    masked.add(variant);
                    if (targetIsDir) {
                        args.push('--tmpfs', variant);
                    }
                    else {
                        args.push('--ro-bind', '/dev/null', variant);
                    }
                }
                else if (lstat.isDirectory()) {
                    masked.add(variant);
                    args.push('--tmpfs', variant);
                }
                else if (lstat.isFile()) {
                    masked.add(variant);
                    args.push('--ro-bind', '/dev/null', variant);
                }
            }
            catch {
                continue;
            }
        }
    };
    if (homeDir) {
        for (const rel of CREDENTIAL_SUBPATHS) {
            const full = path.join(homeDir, rel);
            if (workspaceOverlapsPath(workspaces, full))
                continue;
            maskTarget(full);
        }
    }
    if (Array.isArray(options.extraDenyReadPaths)) {
        for (const extra of options.extraDenyReadPaths) {
            if (typeof extra === 'string' && extra.trim()) {
                maskTarget(extra);
            }
        }
    }
    args.push('--chdir', path.resolve(options.cwd), '--', shell, ...shellArgs);
    return args;
}
/**
 * Wraps a `(shell, shellArgs)` invocation in an OS kernel sandbox when enabled.
 */
export function wrapCommandWithOsSandbox(shell, shellArgs, options) {
    if (typeof shell !== 'string' || shell.length === 0 || shell.includes('\0')) {
        throw new TypeError('wrapCommandWithOsSandbox requires a valid shell executable');
    }
    if (!Array.isArray(shellArgs) || shellArgs.some(arg => typeof arg !== 'string' || arg.includes('\0'))) {
        throw new TypeError('wrapCommandWithOsSandbox requires valid shell arguments');
    }
    if (!options || typeof options !== 'object') {
        throw new TypeError('wrapCommandWithOsSandbox requires an options object');
    }
    if (options.binaryPathOverride !== undefined && (typeof options.binaryPathOverride !== 'string' || options.binaryPathOverride.includes('\0'))) {
        throw new TypeError('Invalid OS sandbox binaryPathOverride');
    }
    const mode = options.mode ?? 'off';
    if (mode === 'off') {
        return {
            command: shell,
            args: [...shellArgs],
            sandboxed: false,
            backend: 'none',
            mode: 'off'
        };
    }
    const platform = options.platform ?? process.platform;
    const backend = options.backendOverride
        ?? (probeOsSandbox({ platform }).available ? probeOsSandbox({ platform }).backend : 'none');
    if (backend === 'seatbelt') {
        const profile = buildSeatbeltProfile({ ...options, mode });
        return {
            command: options.binaryPathOverride || SEATBELT_BIN,
            args: ['-p', profile, '--', shell, ...shellArgs],
            sandboxed: true,
            backend: 'seatbelt',
            mode,
            profile
        };
    }
    if (backend === 'bubblewrap') {
        const bin = options.binaryPathOverride || probeOsSandbox({ platform }).binaryPath || 'bwrap';
        return {
            command: bin,
            args: buildBubblewrapArgs(shell, shellArgs, { ...options, mode }),
            sandboxed: true,
            backend: 'bubblewrap',
            mode
        };
    }
    if (options.strict) {
        const probe = probeOsSandbox({ platform });
        throw new Error(`Strict OS sandbox requested (${mode}) but no kernel sandbox backend is available: ${probe.reason}`);
    }
    return {
        command: shell,
        args: [...shellArgs],
        sandboxed: false,
        backend: 'none',
        mode
    };
}
