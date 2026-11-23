/**
 * Causyne Agent — Workspace File Freshness & Read-Before-Edit Tracker
 *
 * Tracks the last observed `(mtimeMs, size)` for files read or written during
 * the active session so edits can detect external concurrent modifications
 * (e.g., user edits, formatters, or parallel processes) before overwriting.
 */
import fs from 'node:fs';
import path from 'node:path';
const MAX_TRACKED_FILES = 1024;
const observedFiles = new Map();
function canonicalKey(filePath) {
    const resolved = path.resolve(filePath);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
export function recordFileObserved(filePath, stat) {
    if (typeof filePath !== 'string' || !filePath.trim())
        return;
    let meta = stat;
    if (!meta) {
        try {
            const s = fs.statSync(filePath);
            meta = { mtimeMs: s.mtimeMs, size: s.size };
        }
        catch {
            return;
        }
    }
    const key = canonicalKey(filePath);
    if (observedFiles.size >= MAX_TRACKED_FILES && !observedFiles.has(key)) {
        const oldest = observedFiles.keys().next().value;
        if (oldest !== undefined)
            observedFiles.delete(oldest);
    }
    observedFiles.set(key, {
        mtimeMs: meta.mtimeMs,
        size: meta.size,
        observedAt: Date.now()
    });
}
export function checkFileStaleness(filePath, currentStat) {
    if (typeof filePath !== 'string' || !filePath.trim()) {
        return { observed: false, stale: false };
    }
    const key = canonicalKey(filePath);
    const prev = observedFiles.get(key);
    if (!prev) {
        return { observed: false, stale: false };
    }
    let cur = currentStat;
    if (!cur) {
        try {
            const s = fs.statSync(filePath);
            cur = { mtimeMs: s.mtimeMs, size: s.size };
        }
        catch {
            return { observed: true, stale: false };
        }
    }
    // Allow sub-millisecond FS rounding differences (1ms tolerance)
    const mtimeChanged = Math.abs(cur.mtimeMs - prev.mtimeMs) > 1;
    const sizeChanged = cur.size !== prev.size;
    if (mtimeChanged || sizeChanged) {
        return {
            observed: true,
            stale: true,
            warning: `File "${path.basename(filePath)}" was modified externally since your last read (size ${prev.size} -> ${cur.size} bytes). Re-read the file before making further edits.`
        };
    }
    return { observed: true, stale: false };
}
export function clearFileTracker() {
    observedFiles.clear();
}
