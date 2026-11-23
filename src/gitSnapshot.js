// Shadow-git checkpoint backend.
//
// ZERO-MALWARE: every git invocation goes through runGit(), which uses execFile
// with an ARRAY of arguments. There is no shell anywhere in this file, and no
// argument is ever built by string concatenation.
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { causyneHome } from './utils/paths.js';
import { isPhysicalPathAllowed } from './agent/workspaceBoundary.js';
import { isBlockedWorkspaceRoot } from './sandboxPolicy.js';
/** A git call that hangs must not hang a task. */
const GIT_TIMEOUT_MS = 20000;
/** Untracked files above this are excluded rather than stored. */
const MAX_UNTRACKED_BYTES = 2 * 1024 * 1024;
const MAX_PATCH_CHARS = 256 * 1024;
const GIT_SHA_PATTERN = /^[0-9a-f]{40,64}$/i;
function isValidGitSha(sha) {
    return typeof sha === 'string' && GIT_SHA_PATTERN.test(sha);
}
/**
 * Run git.
 *
 * `args` is an ARRAY — execFile passes it straight to execve, so no shell ever
 * parses it and a path containing a space, a quote or `$(...)` is just a path.
 * Never change this to exec() or add `shell: true`.
 */
function hardenedGitEnv(baseEnv) {
    const env = { ...(baseEnv ?? process.env), GIT_TERMINAL_PROMPT: '0' };
    delete env.CAUSYNE_VAULT_KEY;
    delete env.CAUSYNE_DEV_SECRET;
    delete env.GIT_EXTERNAL_DIFF;
    delete env.GIT_PAGER;
    delete env.GIT_EDITOR;
    delete env.GIT_SSH_COMMAND;
    delete env.GIT_ASKPASS;
    return env;
}
function runGit(args, options = {}) {
    if (!Array.isArray(args) || args.some((a) => typeof a !== 'string' || a.includes('\0'))) {
        throw new Error('git arguments must be an array of strings');
    }
    return execFileSync('git', args, {
        encoding: 'utf8',
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        ...options,
        env: hardenedGitEnv(options.env)
    });
}
const execFileAsync = promisify(execFile);
async function runGitAsync(args, options = {}) {
    if (!Array.isArray(args) || args.some((a) => typeof a !== 'string' || a.includes('\0'))) {
        throw new Error('git arguments must be an array of strings');
    }
    const { stdout } = await execFileAsync('git', args, {
        encoding: 'utf8',
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: 32 * 1024 * 1024,
        windowsHide: true,
        ...options,
        env: hardenedGitEnv(options.env)
    });
    return String(stdout ?? '');
}
function resolveActualGitDirs(worktree) {
    const dotGit = path.join(worktree, '.git');
    try {
        const stat = fs.lstatSync(dotGit);
        if (stat.isDirectory()) {
            return { gitDir: dotGit, commonDir: dotGit };
        }
        if (!stat.isSymbolicLink() && stat.isFile() && stat.size > 0 && stat.size <= 4096) {
            const raw = fs.readFileSync(dotGit, 'utf8').trim();
            if (raw.toLowerCase().startsWith('gitdir:')) {
                const target = raw.slice('gitdir:'.length).trim();
                if (target && !target.includes('\0')) {
                    const resolvedGitDir = path.isAbsolute(target) ? path.resolve(target) : path.resolve(worktree, target);
                    let commonDir = resolvedGitDir;
                    const commonFile = path.join(resolvedGitDir, 'commondir');
                    try {
                        const cStat = fs.lstatSync(commonFile);
                        if (!cStat.isSymbolicLink() && cStat.isFile() && cStat.size > 0 && cStat.size <= 4096) {
                            const rel = fs.readFileSync(commonFile, 'utf8').trim();
                            if (rel && !rel.includes('\0')) {
                                commonDir = path.isAbsolute(rel) ? path.resolve(rel) : path.resolve(resolvedGitDir, rel);
                            }
                        }
                    }
                    catch { /* single-dir worktree */ }
                    return { gitDir: resolvedGitDir, commonDir };
                }
            }
        }
    }
    catch {
        // not a git worktree
    }
    return { gitDir: null, commonDir: null };
}
/**
 * Capture without blocking — the form the task hot path must use.
 * Uses a per-capture temp GIT_INDEX_FILE so concurrent tasks never hit index.lock contention.
 */
export async function captureTreeAsync(worktree) {
    const gitDir = initShadow(worktree);
    const tempIndex = path.join(gitDir, `capture-${crypto.randomUUID()}.index`);
    const env = { ...process.env, GIT_INDEX_FILE: tempIndex };
    try {
        excludeOversizedUntracked(gitDir, worktree);
        const baseIndex = path.join(gitDir, 'index');
        try {
            const st = fs.lstatSync(baseIndex);
            if (!st.isSymbolicLink() && st.isFile())
                fs.copyFileSync(baseIndex, tempIndex);
        }
        catch { /* fresh index */ }
        await runGitAsync(['--git-dir', gitDir, '--work-tree', worktree, 'add', '--all'], { cwd: worktree, env });
        const sha = (await runGitAsync(['--git-dir', gitDir, 'write-tree'], { env })).trim();
        return isValidGitSha(sha) ? sha : null;
    }
    catch {
        return null;
    }
    finally {
        try {
            fs.rmSync(tempIndex, { force: true });
        }
        catch { /* ignore */ }
    }
}
/** Is a usable git binary on PATH? Cached — the answer cannot change mid-run. */
let gitAvailable = null;
export function isGitAvailable() {
    if (gitAvailable !== null)
        return gitAvailable;
    try {
        runGit(['--version']);
        gitAvailable = true;
    }
    catch {
        gitAvailable = false;
    }
    return gitAvailable;
}
/** The worktree root for `dir`, or null when it is not inside a git repository. */
export function resolveWorktree(dir) {
    if (typeof dir !== 'string' || !dir.trim() || dir.includes('\0'))
        return null;
    try {
        const out = runGit(['rev-parse', '--show-toplevel'], { cwd: dir });
        const root = out.trim();
        return root ? path.resolve(root) : null;
    }
    catch {
        return null;
    }
}
/** Where this worktree's shadow repository lives. */
export function shadowDirFor(worktree) {
    const resolved = path.resolve(worktree);
    const hash = crypto.createHash('sha256').update(resolved).digest('hex').slice(0, 16);
    const rawName = path.basename(resolved).replace(/[^a-zA-Z0-9._-]/g, '_');
    const safeName = rawName && rawName !== '.' && rawName !== '..' ? rawName.slice(0, 64) : 'repo';
    return path.join(causyneHome(), 'snapshot', safeName, hash);
}
/**
 * Create (or reuse) the shadow repository for a worktree.
 *
 * Returns the --git-dir path. Safe to call repeatedly.
 */
export function initShadow(worktree) {
    if (typeof worktree !== 'string' || !worktree.trim() || worktree.includes('\0') || isBlockedWorkspaceRoot(worktree)) {
        throw new Error('Refusing shadow git snapshot on invalid or blocked workspace root');
    }
    const gitDir = shadowDirFor(worktree);
    const alreadyInitialised = fs.existsSync(path.join(gitDir, 'HEAD'));
    if (fs.existsSync(gitDir)) {
        const stat = fs.lstatSync(gitDir);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
            throw new Error('Refusing symlink or non-directory shadow git repository');
        }
    }
    if (!alreadyInitialised) {
        fs.mkdirSync(gitDir, { recursive: true, mode: 0o700 });
        runGit(['--git-dir', gitDir, 'init', '--bare', '--quiet']);
        // Tuning that matters on large trees, applied once at creation.
        const tuning = [
            ['feature.manyFiles', 'true'],
            ['index.version', '4'],
            ['index.threads', 'true'],
            ['core.untrackedCache', 'true']
        ];
        for (const [key, value] of tuning) {
            try {
                runGit(['--git-dir', gitDir, 'config', key, value]);
            }
            catch {
                // Tuning is an optimisation; an older git that rejects a key must not
                // stop the checkpoint from being taken.
            }
        }
    }
    runGit(['--git-dir', gitDir, 'config', 'core.autocrlf', 'false']);
    const { gitDir: actualGitDir, commonDir: actualCommonDir } = resolveActualGitDirs(worktree);
    const sourceObjects = actualCommonDir ? path.join(actualCommonDir, 'objects') : path.join(worktree, '.git', 'objects');
    try {
        const objStat = fs.lstatSync(sourceObjects);
        if (!objStat.isSymbolicLink() && objStat.isDirectory()) {
            const infoDir = path.join(gitDir, 'objects', 'info');
            fs.mkdirSync(infoDir, { recursive: true, mode: 0o700 });
            const altPath = path.join(infoDir, 'alternates');
            if (!fs.existsSync(altPath) || !fs.lstatSync(altPath).isSymbolicLink()) {
                fs.writeFileSync(altPath, `${sourceObjects}\n`, { encoding: 'utf8', mode: 0o600 });
            }
        }
    }
    catch {
        // best-effort alternates setup
    }
    if (!alreadyInitialised) {
        const sourceIndex = actualGitDir ? path.join(actualGitDir, 'index') : path.join(worktree, '.git', 'index');
        try {
            const idxStat = fs.lstatSync(sourceIndex);
            if (!idxStat.isSymbolicLink() && idxStat.isFile()) {
                fs.copyFileSync(sourceIndex, path.join(gitDir, 'index'));
            }
        }
        catch {
            // best-effort index reuse
        }
    }
    return gitDir;
}
/**
 * Exclude untracked files too large to be worth storing.
 * Written into the SHADOW repo's info/exclude, never the user's .gitignore.
 */
function excludeOversizedUntracked(gitDir, worktree) {
    let listing = '';
    try {
        listing = runGit(['--git-dir', gitDir, '--work-tree', worktree, 'ls-files', '--others', '--exclude-standard', '-z'], { cwd: worktree });
    }
    catch {
        return;
    }
    const oversized = [];
    for (const rel of listing.split('\0')) {
        if (!rel || rel.includes('\r') || rel.includes('\n'))
            continue;
        try {
            const stat = fs.lstatSync(path.join(worktree, rel));
            if (!stat.isSymbolicLink() && stat.isFile() && stat.size > MAX_UNTRACKED_BYTES) {
                oversized.push(rel);
            }
        }
        catch {
            // skip inaccessible entry
        }
    }
    if (oversized.length === 0)
        return;
    try {
        const infoDir = path.join(gitDir, 'info');
        fs.mkdirSync(infoDir, { recursive: true, mode: 0o700 });
        const excludeFile = path.join(infoDir, 'exclude');
        if (!fs.existsSync(excludeFile) || !fs.lstatSync(excludeFile).isSymbolicLink()) {
            fs.writeFileSync(excludeFile, `${oversized.join('\n')}\n`, { encoding: 'utf8', mode: 0o600 });
        }
    }
    catch {
        // best-effort exclude write
    }
}
/**
 * Capture the worktree's current state.
 */
export function captureTree(worktree) {
    let tempIndex = '';
    try {
        const gitDir = initShadow(worktree);
        tempIndex = path.join(gitDir, `capture-${crypto.randomUUID()}.index`);
        const env = { ...process.env, GIT_INDEX_FILE: tempIndex };
        const baseIndex = path.join(gitDir, 'index');
        try {
            const st = fs.lstatSync(baseIndex);
            if (!st.isSymbolicLink() && st.isFile())
                fs.copyFileSync(baseIndex, tempIndex);
        }
        catch { /* fresh index */ }
        excludeOversizedUntracked(gitDir, worktree);
        runGit(['--git-dir', gitDir, '--work-tree', worktree, 'add', '--all'], { cwd: worktree, env });
        const sha = (runGit(['--git-dir', gitDir, 'write-tree'], { env })).trim();
        return isValidGitSha(sha) ? sha : null;
    }
    catch {
        return null;
    }
    finally {
        if (tempIndex) {
            try {
                fs.rmSync(tempIndex, { force: true });
            }
            catch { /* ignore */ }
        }
    }
}
function diffTrees(worktree, leftTree, rightTree) {
    if (!isValidGitSha(leftTree) || !isValidGitSha(rightTree))
        return [];
    const gitDir = initShadow(worktree);
    const tempIndex = path.join(gitDir, `preview-${crypto.randomUUID()}.index`);
    const env = { ...process.env, GIT_INDEX_FILE: tempIndex };
    try {
        runGit(['--git-dir', gitDir, 'read-tree', leftTree], { env });
        const raw = runGit(['--git-dir', gitDir, 'diff', '--numstat', '--find-renames', '-z', leftTree, rightTree], { env });
        const changes = [];
        const tokens = raw.split('\0');
        let idx = 0;
        while (idx < tokens.length) {
            const entry = tokens[idx++] ?? '';
            if (!entry)
                continue;
            const parts = entry.split('\t');
            const added = parts[0] ?? '';
            const removed = parts[1] ?? '';
            let file = parts[2] ?? '';
            if (!file) {
                // Rename/copy under -z emits empty third field followed by oldPath and newPath NUL tokens.
                const oldPath = tokens[idx++] ?? '';
                const newPath = tokens[idx++] ?? '';
                file = newPath || oldPath;
            }
            if (!file)
                continue;
            let patch = '';
            try {
                const rawPatch = runGit(['--git-dir', gitDir, 'diff', '--unified=3', leftTree, rightTree, '--', file], { env });
                patch = rawPatch.length > MAX_PATCH_CHARS
                    ? `${rawPatch.slice(0, MAX_PATCH_CHARS)}\n[... patch truncated ...]\n`
                    : rawPatch;
            }
            catch {
                // A binary file has no textual patch; the counts still describe it.
            }
            changes.push({
                path: file,
                status: added === '-' && removed === '-' ? 'binary' : classify(added, removed),
                additions: added === '-' ? 0 : Number(added) || 0,
                deletions: removed === '-' ? 0 : Number(removed) || 0,
                patch
            });
        }
        return changes;
    }
    finally {
        try {
            fs.rmSync(tempIndex, { force: true });
        }
        catch { /* ignore cleanup error */ }
    }
}
/**
 * What restoring `files` would change — WITHOUT touching the worktree.
 */
export function previewRestore(worktree, fromTree) {
    if (!isValidGitSha(fromTree))
        return [];
    const current = captureTree(worktree);
    if (!current)
        return [];
    return diffTrees(worktree, current, fromTree);
}
/**
 * Forward diff from `fromTree` (checkpoint baseline) to current worktree state.
 */
export function previewForwardDiff(worktree, fromTree) {
    if (!isValidGitSha(fromTree))
        return [];
    const current = captureTree(worktree);
    if (!current)
        return [];
    return diffTrees(worktree, fromTree, current);
}
function classify(added, removed) {
    const a = Number(added) || 0;
    const d = Number(removed) || 0;
    if (a > 0 && d === 0)
        return 'added';
    if (d > 0 && a === 0)
        return 'deleted';
    return 'modified';
}
/**
 * Restore the worktree to `fromTree`.
 */
export function restoreTree(worktree, fromTree) {
    if (!isValidGitSha(fromTree)) {
        throw new Error('Refusing restore: invalid git tree SHA');
    }
    const gitDir = initShadow(worktree);
    const current = captureTree(worktree);
    const toRemove = [];
    if (current) {
        let raw = '';
        try {
            raw = runGit(['--git-dir', gitDir, 'diff', '--no-renames', '--name-status', '-z', current, fromTree]);
        }
        catch {
            raw = '';
        }
        const parts = raw.split('\0');
        const root = path.resolve(worktree);
        let i = 0;
        while (i < parts.length) {
            const status = parts[i] ?? '';
            if (!status) {
                i++;
                continue;
            }
            const code = status[0];
            if (code === 'R' || code === 'C') {
                // Rename/copy records carry 3 NUL-delimited fields: status, oldPath, newPath.
                const oldRel = parts[i + 1] ?? '';
                i += 3;
                if (code === 'R' && oldRel) {
                    const absolute = path.resolve(worktree, oldRel);
                    if (absolute !== root && absolute.startsWith(root + path.sep)) {
                        toRemove.push(absolute);
                    }
                }
                continue;
            }
            const rel = parts[i + 1] ?? '';
            i += 2;
            if (code !== 'D' || !rel)
                continue;
            const absolute = path.resolve(worktree, rel);
            if (absolute !== root && !absolute.startsWith(root + path.sep))
                continue;
            toRemove.push(absolute);
        }
    }
    runGit(['--git-dir', gitDir, '--work-tree', worktree, 'checkout', fromTree, '--', '.'], { cwd: worktree });
    for (const absolute of toRemove) {
        try {
            if (!isPhysicalPathAllowed(absolute, [worktree], false))
                continue;
            const stat = fs.lstatSync(absolute);
            if (stat.isSymbolicLink()) {
                fs.unlinkSync(absolute);
            }
            else if (stat.isFile()) {
                fs.rmSync(absolute, { force: true });
            }
        }
        catch {
            // ignore cleanup error
        }
    }
}
/** Retention: the shadow repo prunes itself rather than growing forever. */
export function pruneShadow(worktree) {
    try {
        const gitDir = initShadow(worktree);
        const cutoff = Date.now() - 60 * 60 * 1000;
        try {
            for (const name of fs.readdirSync(gitDir)) {
                if (!(name.startsWith('preview-') || name.startsWith('capture-')) || !name.endsWith('.index'))
                    continue;
                const full = path.join(gitDir, name);
                const stat = fs.lstatSync(full);
                if (!stat.isSymbolicLink() && stat.isFile() && stat.mtimeMs < cutoff) {
                    fs.unlinkSync(full);
                }
            }
        }
        catch {
            // ignore stale preview index cleanup error
        }
        runGit(['--git-dir', gitDir, 'gc', '--prune=7.days', '--quiet']);
    }
    catch {
        // best-effort prune
    }
}
