import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import * as gitBackend from './gitSnapshot.js';
import { unifiedDiff, looksBinary } from './textDiff.js';
import { causyneHome } from './utils/paths.js';
import { isProtectedPhysicalPath, isWithinPhysicalPath, physicalPath } from './agent/workspaceBoundary.js';
import { isBlockedWorkspaceRoot } from './sandboxPolicy.js';
// @ts-expect-error Legacy sessionStore.js has no TypeScript declarations yet.
import { getActiveSessionId, restoreSessionFromSnapshot, sessionTranscriptFile } from './sessionStore.js';
function debugLog(message) {
    if (process.env.CAUSYNE_DEBUG !== '1')
        return;
    process.stderr.write(`[causyne] ${message}\n`);
}
function storeDir() {
    return path.join(causyneHome(), 'checkpoints');
}
function objectsDir() {
    return path.join(storeDir(), 'objects');
}
function journalFile() {
    return path.join(storeDir(), 'index.jsonl');
}
function statCacheFile() {
    return path.join(storeDir(), 'stat-cache.json');
}
function legacyHistoryFile() {
    return path.join(causyneHome(), 'memory', 'chat_history.json');
}
function activeHistoryFile() {
    try {
        const id = getActiveSessionId();
        if (id) {
            const safe = String(id).replace(/[^a-zA-Z0-9_-]/g, '');
            if (safe)
                return sessionTranscriptFile(safe);
        }
    }
    catch {
        // fall through to the legacy file
    }
    return legacyHistoryFile();
}
const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_STORE_BYTES = 512 * 1024 * 1024;
const MAX_JOURNAL_ENTRIES = 4000;
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_TREE_FILES = 5000;
const MAX_TREE_BYTES = 64 * 1024 * 1024;
const MAX_TREE_FILE_BYTES = 2 * 1024 * 1024;
const MAX_OBJECT_BYTES = 32 * 1024 * 1024;
const IGNORED_DIRECTORIES = new Set([
    '.git', 'node_modules', 'dist', 'build', 'out', 'target',
    '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', '.parcel-cache',
    'venv', '.venv', '__pycache__', '.pytest_cache', '.mypy_cache',
    'vendor', 'Pods', '.gradle', '.idea', '.vscode', 'coverage',
    '.causyne'
]);
const MUTATING_TOOL_PATHS = {
    fs_write: ['path'],
    fs_edit: ['path'],
    MultiEdit: ['file_path'],
    fs_delete: ['path'],
    fs_move: ['source', 'destination']
};
export function isCheckpointingEnabled() {
    return process.env.CAUSYNE_CHECKPOINTS !== '0';
}
function ensureStore() {
    const base = storeDir();
    const objs = objectsDir();
    for (const dir of [base, objs]) {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        }
        else {
            const stat = fs.lstatSync(dir);
            if (stat.isSymbolicLink() || !stat.isDirectory()) {
                throw new Error(`refusing symlink or non-directory checkpoint store: ${dir}`);
            }
        }
    }
}
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
function isValidSha256(hash) {
    return typeof hash === 'string' && SHA256_HEX_RE.test(hash);
}
function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}
function objectPath(hash) {
    if (!isValidSha256(hash)) {
        throw new Error('refusing invalid checkpoint object hash');
    }
    return path.join(objectsDir(), hash.slice(0, 2), hash);
}
function writeObject(buffer) {
    const hash = sha256(buffer);
    const target = objectPath(hash);
    try {
        const existing = fs.lstatSync(target);
        if (existing.isSymbolicLink() || !existing.isFile()) {
            throw new Error('refusing symlink or non-regular checkpoint object');
        }
        return hash;
    }
    catch (err) {
        const code = typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : '';
        if (code !== 'ENOENT')
            throw err;
    }
    const shardDir = path.dirname(target);
    if (!fs.existsSync(shardDir)) {
        fs.mkdirSync(shardDir, { recursive: true, mode: 0o700 });
    }
    else {
        const shardStat = fs.lstatSync(shardDir);
        if (shardStat.isSymbolicLink() || !shardStat.isDirectory()) {
            throw new Error('refusing symlink or non-directory checkpoint shard');
        }
    }
    const temp = `${target}.tmp_${process.pid}_${crypto.randomBytes(6).toString('hex')}`;
    try {
        const fd = fs.openSync(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
        try {
            fs.writeSync(fd, buffer, 0, buffer.length);
            fs.fsyncSync(fd);
        }
        finally {
            fs.closeSync(fd);
        }
        fs.renameSync(temp, target);
    }
    catch (err) {
        try {
            if (fs.existsSync(temp))
                fs.unlinkSync(temp);
        }
        catch { /* ignore */ }
        throw err;
    }
    return hash;
}
function readObject(hash) {
    const target = objectPath(hash);
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error('refusing to read symlink or non-regular checkpoint object');
    }
    if (stat.size > MAX_OBJECT_BYTES) {
        throw new Error('refusing oversized checkpoint object');
    }
    const buf = fs.readFileSync(target);
    if (sha256(buf) !== hash) {
        throw new Error('checkpoint object integrity mismatch');
    }
    return buf;
}
export function resolveToolPath(value) {
    if (typeof value !== 'string' || value.length === 0 || value.includes('\0'))
        return null;
    const trimmed = value.trim();
    if (!trimmed)
        return null;
    let expanded = trimmed;
    if (trimmed === '~') {
        expanded = os.homedir();
    }
    else if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
        expanded = path.join(os.homedir(), trimmed.slice(2));
    }
    return path.resolve(expanded);
}
function appendJournal(entry) {
    const jf = journalFile();
    try {
        const stat = fs.lstatSync(jf);
        if (stat.isSymbolicLink() || !stat.isFile()) {
            throw new Error('refusing symlink or non-regular checkpoint journal');
        }
    }
    catch (err) {
        const code = typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : '';
        if (code !== 'ENOENT')
            throw err;
    }
    fs.appendFileSync(jf, JSON.stringify(entry) + '\n', { encoding: 'utf8', mode: 0o600 });
}
export function readJournal() {
    const jf = journalFile();
    let stat;
    try {
        stat = fs.lstatSync(jf);
    }
    catch {
        return [];
    }
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size === 0 || stat.size > MAX_OBJECT_BYTES)
        return [];
    const raw = fs.readFileSync(jf, 'utf8');
    const entries = [];
    for (const line of raw.split('\n')) {
        if (!line.trim())
            continue;
        try {
            const parsed = JSON.parse(line);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                && typeof parsed.type === 'string'
                && typeof parsed.taskId === 'string') {
                entries.push(parsed);
            }
        }
        catch {
            /* skip a torn line */
        }
    }
    return entries;
}
function rewriteJournal(entries) {
    const jf = journalFile();
    try {
        const stat = fs.lstatSync(jf);
        if (stat.isSymbolicLink() || !stat.isFile()) {
            throw new Error('refusing symlink or non-regular checkpoint journal');
        }
    }
    catch (err) {
        const code = typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : '';
        if (code !== 'ENOENT')
            throw err;
    }
    const temp = `${jf}.tmp_${process.pid}_${crypto.randomBytes(6).toString('hex')}`;
    const payload = Buffer.from(entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''), 'utf8');
    try {
        const fd = fs.openSync(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
        try {
            fs.writeSync(fd, payload, 0, payload.length);
            fs.fsyncSync(fd);
        }
        finally {
            fs.closeSync(fd);
        }
        fs.renameSync(temp, jf);
    }
    catch (err) {
        try {
            if (fs.existsSync(temp))
                fs.unlinkSync(temp);
        }
        catch { /* ignore */ }
        throw err;
    }
}
function newId() {
    return `ck_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}
function snapshotFile(absolutePath) {
    let stats;
    try {
        stats = fs.lstatSync(absolutePath);
    }
    catch {
        return null;
    }
    if (stats.isSymbolicLink()) {
        return { kind: 'symlink', target: fs.readlinkSync(absolutePath), mode: stats.mode & 0o777 };
    }
    if (stats.isDirectory()) {
        return { kind: 'directory', mode: stats.mode & 0o777 };
    }
    if (!stats.isFile()) {
        return { kind: 'special' };
    }
    if (stats.size > MAX_FILE_BYTES) {
        return { kind: 'file', skipped: 'too_large', size: stats.size, mode: stats.mode & 0o777 };
    }
    const buffer = fs.readFileSync(absolutePath);
    return {
        kind: 'file',
        hash: writeObject(buffer),
        size: stats.size,
        mode: stats.mode & 0o777
    };
}
export function captureBeforeMutation(toolName, args, meta) {
    if (!isCheckpointingEnabled())
        return [];
    if (typeof toolName !== 'string' || !args || typeof args !== 'object')
        return [];
    const canonicalTool = toolName.replace(/\./g, '_');
    const fields = Object.hasOwn(MUTATING_TOOL_PATHS, canonicalTool)
        ? MUTATING_TOOL_PATHS[canonicalTool]
        : undefined;
    if (!fields)
        return [];
    const safeMeta = meta && typeof meta === 'object' ? meta : {};
    const taskId = typeof safeMeta.taskId === 'string' && safeMeta.taskId && !safeMeta.taskId.includes('\0')
        ? safeMeta.taskId
        : 'unknown';
    const ids = [];
    try {
        ensureStore();
        for (const field of fields) {
            const absolutePath = resolveToolPath(args[field]);
            if (!absolutePath)
                continue;
            const before = snapshotFile(absolutePath);
            const entry = {
                id: newId(),
                ts: Date.now(),
                type: 'file',
                taskId,
                step: safeMeta.step == null ? null : safeMeta.step,
                tool: toolName,
                path: absolutePath,
                before
            };
            appendJournal(entry);
            ids.push(entry.id);
        }
    }
    catch (e) {
        debugLog(`checkpoint snapshot skipped: ${e instanceof Error ? e.message : String(e)}`);
    }
    return ids;
}
function loadStatCache() {
    try {
        const cf = statCacheFile();
        const stat = fs.lstatSync(cf);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 16 * 1024 * 1024)
            return {};
        const parsed = JSON.parse(fs.readFileSync(cf, 'utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            return {};
        const clean = Object.create(null);
        for (const [key, rec] of Object.entries(parsed)) {
            if (key === '__proto__' || key === 'constructor' || key === 'prototype')
                continue;
            if (rec && typeof rec === 'object' && !Array.isArray(rec)
                && typeof rec.mtimeMs === 'number'
                && typeof rec.size === 'number'
                && isValidSha256(rec.hash)) {
                clean[key] = rec;
            }
        }
        return clean;
    }
    catch {
        return {};
    }
}
function saveStatCache(cache) {
    const cf = statCacheFile();
    const temp = `${cf}.tmp_${process.pid}_${crypto.randomBytes(6).toString('hex')}`;
    try {
        try {
            const existing = fs.lstatSync(cf);
            if (existing.isSymbolicLink() || !existing.isFile())
                return;
        }
        catch (err) {
            const code = typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : '';
            if (code !== 'ENOENT')
                return;
        }
        const payload = Buffer.from(JSON.stringify(cache), 'utf8');
        const fd = fs.openSync(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
        try {
            fs.writeSync(fd, payload, 0, payload.length);
            fs.fsyncSync(fd);
        }
        finally {
            fs.closeSync(fd);
        }
        fs.renameSync(temp, cf);
    }
    catch {
        try {
            if (fs.existsSync(temp))
                fs.unlinkSync(temp);
        }
        catch { /* ignore */ }
    }
}
function snapshotTree(root) {
    const cache = loadStatCache();
    const files = {};
    let fileCount = 0;
    let totalBytes = 0;
    const stack = [root];
    while (stack.length > 0) {
        const dir = stack.pop();
        let entries;
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (IGNORED_DIRECTORIES.has(entry.name))
                    continue;
                stack.push(full);
                continue;
            }
            if (entry.isSymbolicLink()) {
                try {
                    files[full] = { kind: 'symlink', target: fs.readlinkSync(full) };
                }
                catch { /* ignore */ }
                continue;
            }
            if (!entry.isFile())
                continue;
            let stats;
            try {
                stats = fs.lstatSync(full);
            }
            catch {
                continue;
            }
            if (stats.isSymbolicLink() || !stats.isFile())
                continue;
            if (stats.size > MAX_TREE_FILE_BYTES)
                continue;
            fileCount++;
            totalBytes += stats.size;
            if (fileCount > MAX_TREE_FILES)
                return { manifest: null, skipped: 'too_many_files' };
            if (totalBytes > MAX_TREE_BYTES)
                return { manifest: null, skipped: 'workspace_too_large' };
            const cached = Object.hasOwn(cache, full) ? cache[full] : undefined;
            if (cached && isValidSha256(cached.hash) && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size
                && fs.existsSync(objectPath(cached.hash))) {
                files[full] = { kind: 'file', hash: cached.hash, size: stats.size, mode: stats.mode & 0o777 };
                continue;
            }
            try {
                const hash = writeObject(fs.readFileSync(full));
                files[full] = { kind: 'file', hash, size: stats.size, mode: stats.mode & 0o777 };
                cache[full] = { mtimeMs: stats.mtimeMs, size: stats.size, hash };
            }
            catch {
                // vanished mid-walk
            }
        }
    }
    saveStatCache(cache);
    return { manifest: { root, files, fileCount, totalBytes }, skipped: null };
}
const PROJECT_MARKERS = [
    '.git', 'package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml',
    'pom.xml', 'build.gradle', 'build.gradle.kts', 'Gemfile', 'composer.json',
    'requirements.txt', 'CMakeLists.txt', 'Makefile'
];
function isSnapshotableRoot(dir) {
    if (typeof dir !== 'string' || !dir.trim() || dir.includes('\0'))
        return false;
    let resolved;
    try {
        resolved = path.resolve(dir);
    }
    catch {
        return false;
    }
    const home = os.homedir();
    const parsed = path.parse(resolved);
    if (resolved === parsed.root)
        return false;
    if (home && path.resolve(home) === resolved)
        return false;
    const forbidden = ['/Users', '/home', '/Users/Shared', '/var', '/tmp', '/private/tmp', '/etc', '/opt', '/usr'];
    if (forbidden.includes(resolved))
        return false;
    if (isBlockedWorkspaceRoot(resolved))
        return false;
    return true;
}
export function resolveProjectRoot(startDir) {
    let current;
    try {
        current = path.resolve(startDir || process.cwd());
    }
    catch {
        return null;
    }
    const home = os.homedir() ? path.resolve(os.homedir()) : null;
    const stop = path.parse(current).root;
    let nearestMarker = null;
    for (let depth = 0; depth < 40; depth++) {
        if (!isSnapshotableRoot(current))
            break;
        try {
            if (fs.existsSync(path.join(current, '.git')))
                return current;
        }
        catch { /* ignore */ }
        if (!nearestMarker) {
            for (const marker of PROJECT_MARKERS) {
                if (marker === '.git')
                    continue;
                try {
                    if (fs.existsSync(path.join(current, marker))) {
                        nearestMarker = current;
                        break;
                    }
                }
                catch { /* ignore */ }
            }
        }
        const parent = path.dirname(current);
        if (parent === current || current === stop)
            break;
        if (home && parent === home)
            break;
        current = parent;
    }
    return nearestMarker && isSnapshotableRoot(nearestMarker) ? nearestMarker : null;
}
function gitRootFor(root) {
    try {
        if (!gitBackend.isGitAvailable())
            return null;
        const worktree = gitBackend.resolveWorktree(root);
        if (!worktree || path.resolve(worktree) !== path.resolve(root))
            return null;
        return worktree;
    }
    catch (e) {
        debugLog(`git checkpoint unavailable for ${root}: ${e instanceof Error ? e.message : String(e)}`);
        return null;
    }
}
function gitTreeChanges(tree, _undoTaskId, dryRun, applyFull) {
    if (!tree.root || !tree.gitTree)
        return null;
    try {
        const changes = gitBackend.previewRestore(tree.root, tree.gitTree);
        const driftFiles = changes.map((c) => c.path);
        if (!applyFull || dryRun) {
            return {
                driftFiles,
                results: changes.map((c) => ({
                    path: path.join(tree.root, c.path),
                    action: c.status === 'deleted' ? 'removed' : 'restored',
                    ok: true
                }))
            };
        }
        gitBackend.restoreTree(tree.root, tree.gitTree);
        return {
            driftFiles,
            results: changes.map((c) => ({
                path: path.join(tree.root, c.path),
                action: c.status === 'deleted' ? 'removed' : 'restored',
                ok: true
            }))
        };
    }
    catch (e) {
        debugLog(`git restore unavailable for ${tree.root}: ${e instanceof Error ? e.message : String(e)}`);
        return null;
    }
}
export async function beginTask(meta = {}) {
    if (!isCheckpointingEnabled())
        return null;
    const taskId = meta.taskId || 'unknown';
    try {
        ensureStore();
        let history = null;
        const historyFile = activeHistoryFile();
        if (fs.existsSync(historyFile)) {
            const buffer = fs.readFileSync(historyFile);
            history = { hash: writeObject(buffer), size: buffer.length, file: historyFile };
        }
        appendJournal({
            id: newId(),
            ts: Date.now(),
            type: 'task_start',
            taskId,
            prompt: typeof meta.prompt === 'string' ? meta.prompt.slice(0, 200) : null,
            history
        });
        const roots = (meta.workspaceRoots || [])
            .filter((root) => typeof root === 'string' && root.length > 0)
            .filter((root, index, all) => all.indexOf(root) === index)
            .filter((root) => isSnapshotableRoot(root))
            .slice(0, 3);
        for (const root of roots) {
            if (!fs.existsSync(root))
                continue;
            const gitWorktree = gitRootFor(root);
            let gitTree = null;
            if (gitWorktree) {
                try {
                    gitTree = await gitBackend.captureTreeAsync(gitWorktree);
                }
                catch (e) {
                    debugLog(`git capture failed for ${root}: ${e instanceof Error ? e.message : String(e)}`);
                }
            }
            if (gitTree) {
                appendJournal({
                    id: newId(),
                    ts: Date.now(),
                    type: 'tree',
                    taskId,
                    root,
                    skipped: null,
                    backend: 'git',
                    gitTree,
                    manifestHash: null,
                    fileCount: 0,
                    totalBytes: 0
                });
                continue;
            }
            const { manifest, skipped } = snapshotTree(root);
            appendJournal({
                id: newId(),
                ts: Date.now(),
                type: 'tree',
                taskId,
                root,
                skipped,
                manifestHash: manifest ? writeObject(Buffer.from(JSON.stringify(manifest), 'utf8')) : null,
                fileCount: manifest ? manifest.fileCount : 0,
                totalBytes: manifest ? manifest.totalBytes : 0
            });
        }
        return taskId;
    }
    catch (e) {
        debugLog(`checkpoint task snapshot skipped: ${e instanceof Error ? e.message : String(e)}`);
        return null;
    }
}
function assertSafeTarget(absolutePath) {
    if (typeof absolutePath !== 'string' || !absolutePath || absolutePath.includes('\0')) {
        throw new Error('refusing an invalid checkpoint target path');
    }
    if (!path.isAbsolute(absolutePath)) {
        throw new Error(`refusing a non-absolute path: ${absolutePath}`);
    }
    if (absolutePath !== path.resolve(absolutePath)) {
        throw new Error(`refusing an unnormalised path: ${absolutePath}`);
    }
    try {
        const stats = fs.lstatSync(absolutePath);
        if (stats.isSymbolicLink()) {
            throw new Error(`refusing to write through a symlink: ${absolutePath}`);
        }
        if (stats.isFile() && stats.nlink > 1) {
            throw new Error(`refusing to write through a hardlink (${stats.nlink} links): ${absolutePath}`);
        }
    }
    catch (err) {
        const code = typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : '';
        if (code !== 'ENOENT')
            throw err;
    }
    // Walk existing ancestors to refuse symlinked parent directories (allowing only
    // canonical macOS OS-level /var and /tmp symlinks into /private).
    let ancestor = path.dirname(absolutePath);
    for (let depth = 0; depth < 128; depth++) {
        const parent = path.dirname(ancestor);
        if (parent === ancestor)
            break;
        try {
            const aStat = fs.lstatSync(ancestor);
            if (aStat.isSymbolicLink()) {
                const isDarwinOsLink = process.platform === 'darwin' && (ancestor === '/var' || ancestor === '/tmp');
                if (!isDarwinOsLink) {
                    throw new Error(`refusing to write through a symlink ancestor: ${ancestor}`);
                }
            }
        }
        catch (err) {
            const code = typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : '';
            if (code !== 'ENOENT')
                throw err;
        }
        ancestor = parent;
    }
    const realTarget = physicalPath(absolutePath);
    if (!realTarget) {
        throw new Error(`refusing to write through a symlink or unresolvable path: ${absolutePath}`);
    }
    if (isProtectedPhysicalPath(absolutePath) || isProtectedPhysicalPath(realTarget)) {
        throw new Error(`refusing to write into a protected system path: ${absolutePath}`);
    }
}
function restoreFileState(absolutePath, before) {
    assertSafeTarget(absolutePath);
    if (before === null || before === undefined) {
        if (fs.existsSync(absolutePath))
            fs.rmSync(absolutePath, { recursive: true, force: true });
        return 'removed';
    }
    if (before.kind === 'symlink') {
        if (typeof before.target !== 'string' || !before.target || before.target.includes('\0')) {
            throw new Error('refusing to restore symlink with invalid target');
        }
        try {
            fs.lstatSync(absolutePath);
            fs.unlinkSync(absolutePath);
        }
        catch { /* nothing there */ }
        fs.symlinkSync(before.target, absolutePath);
        return 'restored symlink';
    }
    if (before.kind === 'directory') {
        fs.mkdirSync(absolutePath, { recursive: true });
        return 'restored directory';
    }
    if (before.kind !== 'file')
        return 'skipped (not a regular file)';
    if (before.skipped || !before.hash || !isValidSha256(before.hash)) {
        return `skipped (${before.skipped || 'missing_hash'})`;
    }
    const buffer = readObject(before.hash);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    const temp = `${absolutePath}.causyne_restore_${process.pid}_${crypto.randomBytes(6).toString('hex')}`;
    try {
        const fd = fs.openSync(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, before.mode || 0o644);
        try {
            fs.writeSync(fd, buffer, 0, buffer.length);
            fs.fsyncSync(fd);
        }
        finally {
            fs.closeSync(fd);
        }
        fs.renameSync(temp, absolutePath);
    }
    catch (err) {
        try {
            if (fs.existsSync(temp))
                fs.unlinkSync(temp);
        }
        catch { /* ignore */ }
        throw err;
    }
    return 'restored';
}
export function diffTree(treeEntry) {
    if (!treeEntry || !treeEntry.manifestHash || treeEntry.skipped)
        return null;
    let manifest;
    try {
        manifest = JSON.parse(readObject(treeEntry.manifestHash).toString('utf8'));
    }
    catch {
        return null;
    }
    const modified = [];
    const deleted = [];
    const known = new Set(Object.keys(manifest.files || {}));
    for (const [absolutePath, record] of Object.entries(manifest.files || {})) {
        if (record.kind !== 'file' || record.skipped)
            continue;
        let stats;
        try {
            stats = fs.lstatSync(absolutePath);
        }
        catch {
            deleted.push(absolutePath);
            continue;
        }
        if (stats.isSymbolicLink() || !stats.isFile())
            continue;
        if (stats.size !== record.size) {
            modified.push(absolutePath);
            continue;
        }
        try {
            if (sha256(fs.readFileSync(absolutePath)) !== record.hash)
                modified.push(absolutePath);
        }
        catch {
            // unreadable now: leave it alone rather than guess
        }
    }
    const created = [];
    const { manifest: current } = snapshotTree(manifest.root);
    if (current) {
        for (const absolutePath of Object.keys(current.files)) {
            if (!known.has(absolutePath))
                created.push(absolutePath);
        }
    }
    return { modified, created, deleted, manifest };
}
function restoreFromTree(treeEntry, undoTaskId, dryRun) {
    const diff = diffTree(treeEntry);
    if (!diff)
        return [];
    const results = [];
    const apply = (absolutePath, before, label) => {
        if (dryRun) {
            results.push({ path: absolutePath, action: `would ${label}` });
            return;
        }
        try {
            const current = snapshotFile(absolutePath);
            appendJournal({
                id: newId(), ts: Date.now(), type: 'file', taskId: undoTaskId,
                step: null, tool: 'undo-tree', path: absolutePath, before: current
            });
            results.push({ path: absolutePath, action: restoreFileState(absolutePath, before) });
        }
        catch (e) {
            results.push({ path: absolutePath, action: `FAILED: ${e instanceof Error ? e.message : String(e)}` });
        }
    };
    for (const absolutePath of [...diff.modified, ...diff.deleted]) {
        apply(absolutePath, diff.manifest.files[absolutePath], 'restore');
    }
    for (const absolutePath of diff.created) {
        apply(absolutePath, null, 'remove');
    }
    return results;
}
export function isUndoable(group) {
    if (!group)
        return false;
    return group.fileEntries.length > 0 || group.trees.some((tree) => !tree.skipped);
}
export function listGroups(limit = 20) {
    const entries = readJournal();
    const byTask = new Map();
    for (const entry of entries) {
        if (!byTask.has(entry.taskId)) {
            byTask.set(entry.taskId, { taskId: entry.taskId, ts: entry.ts, entries: [], prompt: null });
        }
        const group = byTask.get(entry.taskId);
        group.ts = Math.max(group.ts, entry.ts);
        if (entry.type === 'task_start' && entry.prompt)
            group.prompt = entry.prompt;
        group.entries.push(entry);
    }
    return [...byTask.values()]
        .sort((a, b) => b.ts - a.ts)
        .slice(0, limit)
        .map(group => ({
        ...group,
        fileEntries: group.entries.filter(e => e.type === 'file'),
        hasHistory: group.entries.some(e => e.type === 'task_start' && Boolean(e.history)),
        trees: group.entries.filter(e => e.type === 'tree')
    }));
}
export function undoTask(taskId, options = {}) {
    const dryRun = options.dryRun !== false;
    const groups = listGroups(1000);
    const group = groups.find(g => g.taskId === taskId);
    if (!group)
        return { ok: false, error: `no checkpoint group for task "${taskId}"` };
    const results = [];
    const undoTaskId = `undo_${Date.now().toString(36)}`;
    const earliest = new Map();
    for (const entry of [...group.fileEntries].sort((a, b) => a.ts - b.ts)) {
        if (entry.path && !earliest.has(entry.path))
            earliest.set(entry.path, entry);
    }
    const wantsFiles = options.scope !== 'conversation';
    const wantsHistory = options.scope !== 'code';
    for (const entry of (wantsFiles ? earliest.values() : [])) {
        if (!entry.path)
            continue;
        if (dryRun) {
            results.push({ path: entry.path, action: entry.before === null ? 'would remove' : 'would restore' });
            continue;
        }
        try {
            const current = snapshotFile(entry.path);
            appendJournal({
                id: newId(), ts: Date.now(), type: 'file', taskId: undoTaskId,
                step: null, tool: 'undo', path: entry.path, before: current
            });
            const action = restoreFileState(entry.path, entry.before);
            results.push({ path: entry.path, action });
        }
        catch (e) {
            results.push({ path: entry.path, action: `FAILED: ${e instanceof Error ? e.message : String(e)}` });
        }
    }
    let historyRestored = false;
    const start = group.entries.find(e => e.type === 'task_start' && e.history);
    if (start && start.history && !dryRun && wantsHistory) {
        const target = start.history.file || legacyHistoryFile();
        try {
            const root = causyneHome();
            const resolved = path.resolve(target);
            const realRoot = physicalPath(root);
            const realTarget = physicalPath(resolved);
            if (!realRoot || !realTarget || !isWithinPhysicalPath(realTarget, realRoot)) {
                throw new Error('conversation snapshot points outside the Causyne state directory');
            }
            if (fs.existsSync(resolved)) {
                const curStat = fs.lstatSync(resolved);
                if (!curStat.isSymbolicLink() && curStat.isFile()) {
                    const buffer = fs.readFileSync(resolved);
                    appendJournal({
                        id: newId(), ts: Date.now(), type: 'task_start', taskId: undoTaskId,
                        prompt: 'undo restore point',
                        history: { hash: writeObject(buffer), size: buffer.length, file: resolved }
                    });
                }
            }
            const snapshot = readObject(start.history.hash);
            if (path.extname(resolved) === '.jsonl') {
                historyRestored = restoreSessionFromSnapshot(resolved, snapshot);
                if (!historyRestored)
                    throw new Error('conversation journal snapshot could not be projected');
            }
            else {
                assertSafeTarget(resolved);
                fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
                const temp = `${resolved}.tmp_${process.pid}_${crypto.randomBytes(6).toString('hex')}`;
                try {
                    const fd = fs.openSync(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
                    try {
                        fs.writeSync(fd, snapshot, 0, snapshot.length);
                        fs.fsyncSync(fd);
                    }
                    finally {
                        fs.closeSync(fd);
                    }
                    fs.renameSync(temp, resolved);
                }
                catch (writeErr) {
                    try {
                        if (fs.existsSync(temp))
                            fs.unlinkSync(temp);
                    }
                    catch { /* ignore */ }
                    throw writeErr;
                }
                historyRestored = true;
            }
        }
        catch (e) {
            results.push({ path: target, action: `FAILED: ${e instanceof Error ? e.message : String(e)}` });
        }
    }
    const drift = [];
    const treeResults = [];
    for (const tree of (wantsFiles ? group.trees : [])) {
        if (tree.skipped || !tree.root)
            continue;
        if (tree.backend === 'git' && tree.gitTree) {
            const gitChanges = gitTreeChanges(tree, undoTaskId, dryRun, options.full === true);
            if (gitChanges) {
                if (options.full)
                    treeResults.push(...gitChanges.results);
                else if (gitChanges.driftFiles.length > 0) {
                    drift.push({ root: tree.root, files: gitChanges.driftFiles });
                }
                continue;
            }
        }
        if (options.full) {
            treeResults.push(...restoreFromTree(tree, undoTaskId, dryRun));
            continue;
        }
        const diff = diffTree(tree);
        if (!diff)
            continue;
        const untracked = [...diff.modified, ...diff.created, ...diff.deleted]
            .filter(p => !earliest.has(p));
        if (untracked.length > 0)
            drift.push({ root: tree.root, files: untracked });
    }
    return {
        ok: true,
        taskId,
        dryRun,
        full: options.full === true,
        results: [...results, ...treeResults],
        historyRestored,
        historyAvailable: Boolean(start),
        scope: options.scope || 'both',
        drift,
        skippedTrees: group.trees.filter(t => t.skipped).map(t => ({ root: t.root, reason: t.skipped }))
    };
}
export function undoLast(options) {
    const safeOptions = options && typeof options === 'object' ? options : {};
    const hasExplicitWorkspace = typeof safeOptions.workspaceRoot === 'string' && safeOptions.workspaceRoot.trim().length > 0;
    const ws = hasExplicitWorkspace ? path.resolve(safeOptions.workspaceRoot) : path.resolve(process.cwd());
    const allCandidates = listGroups(200).filter((group) => !group.taskId.startsWith('undo_') && isUndoable(group));
    const validCandidates = allCandidates.filter((group) => {
        const allPaths = [
            ...group.trees.map((t) => t.root).filter((p) => Boolean(p)),
            ...group.fileEntries.map((e) => e.path).filter((p) => Boolean(p))
        ];
        if (allPaths.length > 0 && allPaths.every((p) => (p.startsWith('/var/folders/') || p.startsWith('/tmp/')) && !fs.existsSync(p))) {
            return false;
        }
        return true;
    });
    const workspaceCandidates = validCandidates.filter((group) => {
        const matchesTree = group.trees.some((t) => t.root && (t.root === ws || ws.startsWith(t.root + path.sep) || t.root.startsWith(ws + path.sep)));
        const matchesFile = group.fileEntries.some((e) => e.path && (e.path.startsWith(ws + path.sep) || e.path === ws));
        return matchesTree || matchesFile;
    });
    const candidates = hasExplicitWorkspace
        ? workspaceCandidates
        : (workspaceCandidates.length > 0 ? workspaceCandidates : validCandidates);
    if (candidates.length === 0) {
        return { ok: false, error: 'nothing has been checkpointed yet — no task has run in this workspace' };
    }
    return undoTask(candidates[0].taskId, safeOptions);
}
export function undoStep(options = {}) {
    const dryRun = options.dryRun !== false;
    const entries = readJournal().filter(e => e.type === 'file' && e.tool !== 'undo' && Boolean(e.path));
    if (entries.length === 0)
        return { ok: false, error: 'no file mutation has been checkpointed yet' };
    const entry = entries[entries.length - 1];
    const targetPath = entry.path;
    if (dryRun) {
        return { ok: true, dryRun, results: [{ path: targetPath, action: entry.before === null ? 'would remove' : 'would restore' }] };
    }
    try {
        const current = snapshotFile(targetPath);
        appendJournal({
            id: newId(), ts: Date.now(), type: 'file', taskId: `undo_${Date.now().toString(36)}`,
            step: null, tool: 'undo', path: targetPath, before: current
        });
        const action = restoreFileState(targetPath, entry.before);
        return { ok: true, dryRun: false, results: [{ path: targetPath, action }] };
    }
    catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
}
function directorySize(dir) {
    let total = 0;
    const stack = [dir];
    while (stack.length > 0) {
        const current = stack.pop();
        let entries;
        try {
            entries = fs.readdirSync(current, { withFileTypes: true });
        }
        catch {
            continue;
        }
        for (const entry of entries) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) {
                stack.push(full);
                continue;
            }
            try {
                total += fs.statSync(full).size;
            }
            catch { /* ignore */ }
        }
    }
    return total;
}
export function pruneStore() {
    try {
        const jf = journalFile();
        const objs = objectsDir();
        if (!fs.existsSync(jf))
            return { removedEntries: 0, removedObjects: 0 };
        let entries = readJournal();
        const before = entries.length;
        const cutoff = Date.now() - RETENTION_MS;
        const overSize = directorySize(objs) > MAX_STORE_BYTES;
        entries = entries.filter(e => e.ts >= cutoff);
        if (entries.length > MAX_JOURNAL_ENTRIES || overSize) {
            const keep = overSize ? Math.floor(MAX_JOURNAL_ENTRIES / 2) : MAX_JOURNAL_ENTRIES;
            entries = entries.slice(-keep);
        }
        if (entries.length !== before)
            rewriteJournal(entries);
        const live = new Set();
        for (const entry of entries) {
            if (entry.before && entry.before.kind === 'file' && entry.before.hash)
                live.add(entry.before.hash);
            if (entry.history && entry.history.hash)
                live.add(entry.history.hash);
            if (entry.manifestHash) {
                live.add(entry.manifestHash);
                try {
                    const manifest = JSON.parse(readObject(entry.manifestHash).toString('utf8'));
                    for (const record of Object.values(manifest.files || {})) {
                        if (record && record.kind === 'file' && record.hash)
                            live.add(record.hash);
                    }
                }
                catch {
                    // an unreadable manifest keeps only itself alive
                }
            }
        }
        let removedObjects = 0;
        let shards;
        try {
            shards = fs.readdirSync(objs);
        }
        catch {
            shards = [];
        }
        for (const shard of shards) {
            const shardDir = path.join(objs, shard);
            let objects;
            try {
                objects = fs.readdirSync(shardDir);
            }
            catch {
                continue;
            }
            for (const name of objects) {
                if (live.has(name))
                    continue;
                try {
                    fs.unlinkSync(path.join(shardDir, name));
                    removedObjects++;
                }
                catch { /* ignore */ }
            }
            try {
                if (fs.readdirSync(shardDir).length === 0)
                    fs.rmdirSync(shardDir);
            }
            catch { /* ignore */ }
        }
        return { removedEntries: before - entries.length, removedObjects };
    }
    catch (e) {
        debugLog(`checkpoint prune skipped: ${e instanceof Error ? e.message : String(e)}`);
        return { removedEntries: 0, removedObjects: 0 };
    }
}
export function getStoreDir() {
    return storeDir();
}
export function getStoreStats() {
    const objs = objectsDir();
    return {
        dir: storeDir(),
        entries: readJournal().length,
        bytes: fs.existsSync(objs) ? directorySize(objs) : 0
    };
}
export function buildTaskDiff(taskId) {
    const group = listGroups(1000).find((g) => g.taskId === taskId);
    if (!group) {
        return { ok: false, taskId: taskId || null, error: 'no checkpoint for that task', files: [] };
    }
    const files = [];
    for (const tree of group.trees || []) {
        if (tree.backend !== 'git' || !tree.gitTree || !tree.root)
            continue;
        try {
            for (const change of gitBackend.previewRestore(tree.root, tree.gitTree)) {
                files.push({
                    path: change.path,
                    status: change.status === 'deleted' ? 'created'
                        : change.status === 'added' ? 'deleted'
                            : change.status,
                    additions: change.deletions,
                    deletions: change.additions,
                    patch: change.patch || '',
                    truncated: false
                });
            }
        }
        catch (e) {
            debugLog(`task diff unavailable for ${tree.root}: ${e instanceof Error ? e.message : String(e)}`);
        }
    }
    const seen = new Set(files.map((f) => f.path));
    for (const entry of group.fileEntries || []) {
        if (!entry.path)
            continue;
        const fromCwd = path.relative(process.cwd(), entry.path);
        const relative = (!fromCwd || fromCwd.startsWith('..'))
            ? path.basename(entry.path)
            : fromCwd;
        if (seen.has(relative))
            continue;
        seen.add(relative);
        const beforeBuffer = entry.before && entry.before.kind === 'file' && entry.before.hash
            ? readObject(entry.before.hash)
            : null;
        let afterBuffer = null;
        try {
            if (fs.existsSync(entry.path))
                afterBuffer = fs.readFileSync(entry.path);
        }
        catch { /* ignore */ }
        const status = !beforeBuffer ? 'created' : !afterBuffer ? 'deleted' : 'modified';
        if (looksBinary(beforeBuffer) || looksBinary(afterBuffer)) {
            files.push({
                path: relative, status, additions: 0, deletions: 0, patch: '', truncated: true
            });
            continue;
        }
        const diff = unifiedDiff(beforeBuffer ? beforeBuffer.toString('utf8') : '', afterBuffer ? afterBuffer.toString('utf8') : '', relative);
        files.push({
            path: relative,
            status,
            additions: diff.additions,
            deletions: diff.deletions,
            patch: diff.patch,
            truncated: diff.truncated
        });
    }
    const totals = files.reduce((acc, f) => ({ additions: acc.additions + f.additions, deletions: acc.deletions + f.deletions }), { additions: 0, deletions: 0 });
    return {
        ok: true,
        taskId: group.taskId,
        prompt: group.prompt || null,
        fileCount: files.length,
        additions: totals.additions,
        deletions: totals.deletions,
        files: files.slice(0, 50)
    };
}
