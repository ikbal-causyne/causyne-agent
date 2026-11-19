// Dynamic canonical workspace identity & display helpers for Causyne Agent TUI.
// Authored in Strict TypeScript. Never hardcodes user or project workspace names.
// Source-available under BUSL-1.1.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { safeDisplay } from './text.js';
function cleanInlineText(value) {
    return safeDisplay(typeof value === 'string' ? value : String(value ?? ''))
        .replace(/[\r\n\t]+/g, ' ')
        .trim();
}
function getUserHomeDir() {
    const fromEnv = process.env.HOME || process.env.USERPROFILE || '';
    if (fromEnv && fromEnv.trim())
        return fromEnv.trim();
    try {
        return os.homedir() || '';
    }
    catch {
        return '';
    }
}
function isDriveRoot(value) {
    return value.length >= 2
        && value.length <= 3
        && ((value[0] >= 'A' && value[0] <= 'Z') || (value[0] >= 'a' && value[0] <= 'z'))
        && value[1] === ':'
        && (value.length === 2 || value[2] === '\\' || value[2] === '/');
}
/**
 * Resolve a workspace path into a canonical comparison key.
 * Resolves symlinks (for example `/tmp` vs `/private/tmp` on macOS) when the
 * directory exists on disk, falling back to `path.resolve()` otherwise.
 */
export function canonicalWorkspacePath(workspacePath, cache) {
    if (typeof workspacePath !== 'string')
        return '';
    const trimmed = workspacePath.trim();
    if (!trimmed)
        return '';
    const resolved = path.resolve(trimmed);
    const cached = cache?.get(resolved);
    if (cached !== undefined)
        return cached;
    let canonical = resolved;
    try {
        canonical = typeof fs.realpathSync.native === 'function'
            ? fs.realpathSync.native(resolved)
            : fs.realpathSync(resolved);
    }
    catch {
        // Missing or synthetic paths keep their lexical resolved form.
    }
    const normalized = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
    if (cache)
        cache.set(resolved, normalized);
    return normalized;
}
/**
 * True when two workspace paths refer to the same canonical directory.
 */
export function sameWorkspace(first, second, cache) {
    const a = canonicalWorkspacePath(first, cache);
    const b = canonicalWorkspacePath(second, cache);
    return a.length > 0 && a === b;
}
/**
 * Shorten a workspace path for display by replacing the exact home prefix with `~`.
 * Always sanitized for safe single-line terminal rendering.
 */
export function shortenWorkspacePath(workspacePath) {
    if (typeof workspacePath !== 'string' || !workspacePath.trim())
        return '(default)';
    const trimmed = workspacePath.trim();
    const home = getUserHomeDir();
    if (home) {
        const resolved = path.resolve(trimmed);
        const resolvedHome = path.resolve(home);
        const cmpResolved = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
        const cmpHome = process.platform === 'win32' ? resolvedHome.toLowerCase() : resolvedHome;
        if (cmpResolved === cmpHome)
            return '~';
        const prefix = cmpHome.endsWith(path.sep) ? cmpHome : `${cmpHome}${path.sep}`;
        if (cmpResolved.startsWith(prefix)) {
            const tail = resolved.slice(resolvedHome.length);
            return cleanInlineText(`~${tail}`) || '~';
        }
    }
    return cleanInlineText(trimmed) || '(default)';
}
/**
 * Dynamically derive the human-readable workspace folder name from any path
 * without hardcoding user or repository names.
 */
export function workspaceDisplayName(workspacePath, cache) {
    if (typeof workspacePath !== 'string' || !workspacePath.trim())
        return 'Current Workspace';
    const trimmed = workspacePath.trim();
    const resolved = path.resolve(trimmed);
    const home = getUserHomeDir();
    if (home && sameWorkspace(resolved, home, cache)) {
        return '~';
    }
    const base = path.basename(resolved);
    const cleanBase = cleanInlineText(base);
    if (cleanBase)
        return cleanBase;
    const cleanRoot = cleanInlineText(resolved);
    return cleanRoot || 'Current Workspace';
}
/**
 * Format the dynamic section header label for the active workspace's sessions.
 * Preserves the user's folder casing (for example `suika-game SESSIONS (2)` or
 * `causyne-agent SESSIONS (0)`) while handling home and filesystem roots cleanly.
 */
export function formatWorkspaceSectionTitle(workspacePath, sessionCount, cache) {
    const name = workspaceDisplayName(workspacePath, cache);
    let base;
    if (name === '~') {
        base = 'HOME (~) SESSIONS';
    }
    else if (name === '/' || isDriveRoot(name)) {
        base = `WORKSPACE (${name}) SESSIONS`;
    }
    else {
        base = `${name} SESSIONS`;
    }
    if (typeof sessionCount === 'number' && Number.isFinite(sessionCount) && sessionCount >= 0) {
        return `${base} (${Math.floor(sessionCount)})`;
    }
    return base;
}
