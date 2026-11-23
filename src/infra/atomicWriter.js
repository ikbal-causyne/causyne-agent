/**
 * @file src/infra/atomicWriter.ts
 * Causyne Agent — Cross-Platform Atomic Safe File Writer
 *
 * Implements lock-free atomic file writing using O_EXCL temporary files,
 * fsync durability, and Windows-resilient atomic rename retry backoff for
 * transient antivirus/indexer EPERM/EACCES/EBUSY file locks.
 *
 * Authorship: Strict TypeScript (Causyne Agent).
 */
import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
const TRANSIENT_WIN_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const DEFAULT_RENAME_BACKOFF_MS = [10, 25, 50, 100, 150];
function readErrorCode(err) {
    return typeof err === 'object' && err !== null && 'code' in err
        ? String(err.code || '')
        : '';
}
function sleepSyncMs(ms) {
    if (ms <= 0)
        return;
    try {
        const sab = new SharedArrayBuffer(4);
        const view = new Int32Array(sab);
        Atomics.wait(view, 0, 0, ms);
    }
    catch {
        const until = Date.now() + ms;
        while (Date.now() < until) {
            // Fallback when SharedArrayBuffer is disabled
        }
    }
}
/**
 * Rename `src` onto `dest` with bounded retry backoff for transient Windows
 * antivirus / search-indexer locks (`EPERM`, `EACCES`, `EBUSY`).
 */
export function atomicRenameSync(src, dest, options = {}) {
    const platform = options.platform ?? process.platform;
    const maxRetries = platform === 'win32'
        ? Math.max(0, options.maxRetries ?? DEFAULT_RENAME_BACKOFF_MS.length)
        : 0;
    let attempt = 0;
    while (true) {
        try {
            fs.renameSync(src, dest);
            return;
        }
        catch (err) {
            const code = readErrorCode(err);
            if (attempt >= maxRetries || !TRANSIENT_WIN_RENAME_CODES.has(code)) {
                throw err;
            }
            const delay = DEFAULT_RENAME_BACKOFF_MS[Math.min(attempt, DEFAULT_RENAME_BACKOFF_MS.length - 1)] ?? 50;
            sleepSyncMs(delay);
            attempt++;
        }
    }
}
/**
 * Async rename with bounded retry backoff for transient Windows file locks.
 */
export async function atomicRename(src, dest, options = {}) {
    const platform = options.platform ?? process.platform;
    const maxRetries = platform === 'win32'
        ? Math.max(0, options.maxRetries ?? DEFAULT_RENAME_BACKOFF_MS.length)
        : 0;
    let attempt = 0;
    while (true) {
        try {
            await fsPromises.rename(src, dest);
            return;
        }
        catch (err) {
            const code = readErrorCode(err);
            if (attempt >= maxRetries || !TRANSIENT_WIN_RENAME_CODES.has(code)) {
                throw err;
            }
            const delay = DEFAULT_RENAME_BACKOFF_MS[Math.min(attempt, DEFAULT_RENAME_BACKOFF_MS.length - 1)] ?? 50;
            await new Promise((resolve) => setTimeout(resolve, delay));
            attempt++;
        }
    }
}
export function atomicWriteFileSync(targetPath, content, options = {}) {
    const resolved = path.resolve(targetPath);
    const dir = path.dirname(resolved);
    const mode = options.mode ?? 0o644;
    const dirMode = options.mode !== undefined
        ? (options.mode | ((options.mode & 0o444) >> 2))
        : 0o755;
    fs.mkdirSync(dir, { recursive: true, mode: dirMode });
    const randomSuffix = `${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
    const tempPath = path.join(dir, `.${path.basename(resolved)}.${randomSuffix}.tmp`);
    try {
        const payload = typeof content === 'string'
            ? Buffer.from(content, options.encoding ?? 'utf8')
            : content;
        const fd = fs.openSync(tempPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, mode);
        try {
            fs.writeSync(fd, payload, 0, payload.length);
            fs.fsyncSync(fd);
        }
        finally {
            fs.closeSync(fd);
        }
        atomicRenameSync(tempPath, resolved);
    }
    catch (err) {
        try {
            if (fs.existsSync(tempPath))
                fs.unlinkSync(tempPath);
        }
        catch {
            // Ignore cleanup error
        }
        throw err;
    }
}
export async function atomicWriteFile(targetPath, content, options = {}) {
    atomicWriteFileSync(targetPath, content, options);
}
