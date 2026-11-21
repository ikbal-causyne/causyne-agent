import fs from 'node:fs';
import path from 'node:path';
import { causyneHome } from './utils/paths.js';
function sessionDir() {
    return path.join(causyneHome(), 'embodiment');
}
const RETENTION_MS = 24 * 60 * 60 * 1000;
export function isSessionTrackingEnabled() {
    return process.env.CAUSYNE_EMBODIMENT_SESSION !== '0';
}
function ensureSessionDir() {
    fs.mkdirSync(sessionDir(), { recursive: true, mode: 0o700 });
}
function safeTaskId(taskId) {
    const cleaned = String(taskId || 'default').replace(/[^a-zA-Z0-9_-]/g, '');
    return cleaned === '' ? 'default' : cleaned.slice(0, 64);
}
function sessionFile(taskId) {
    return path.join(sessionDir(), `${safeTaskId(taskId)}.json`);
}
function digestOf(text) {
    let hash = 5381;
    const source = String(text || '');
    for (let i = 0; i < source.length; i++) {
        hash = ((hash * 33) ^ source.charCodeAt(i)) >>> 0;
    }
    return `${hash.toString(16)}:${source.length}`;
}
export function recordObservation(taskId, app, treeText) {
    if (!isSessionTrackingEnabled())
        return;
    try {
        ensureSessionDir();
        const previous = readSession(taskId) || {};
        const state = {
            ...previous,
            app: app || previous.app || '',
            lastTreeDigest: digestOf(treeText),
            lastTreeNodeCount: String(treeText || '').split('\n').filter(Boolean).length,
            observedAt: new Date().toISOString()
        };
        fs.writeFileSync(sessionFile(taskId), JSON.stringify(state, null, 2), { mode: 0o600 });
    }
    catch {
        // Fail open: a lost session record must never fail the task.
    }
}
export function recordActuation(taskId, app, verbs) {
    if (!isSessionTrackingEnabled())
        return;
    try {
        ensureSessionDir();
        const previous = readSession(taskId) || {};
        const state = {
            ...previous,
            app: app || previous.app || '',
            lastActions: Array.isArray(verbs) ? verbs.map(v => String(v)).slice(0, 12) : [],
            lastTreeDigest: null,
            actedAt: new Date().toISOString()
        };
        fs.writeFileSync(sessionFile(taskId), JSON.stringify(state, null, 2), { mode: 0o600 });
    }
    catch {
        // Fail open.
    }
}
export function readSession(taskId) {
    try {
        const file = sessionFile(taskId);
        if (!fs.existsSync(file))
            return null;
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
    catch {
        return null;
    }
}
export function describeSession(taskId) {
    const state = readSession(taskId);
    if (!state || (!state.app && !state.lastActions))
        return '';
    const parts = [];
    parts.push(`You were driving ${state.app ? `"${state.app}"` : 'the frontmost application'} before this session resumed.`);
    if (Array.isArray(state.lastActions) && state.lastActions.length > 0) {
        parts.push(`Your last actions were: ${state.lastActions.join(', ')}.`);
        parts.push('You do NOT know whether they landed — the screen may have changed while you were gone.');
    }
    parts.push('Call ax_snapshot before acting again, and compare what you see to what you expected.');
    return `\n\n◆ EMBODIMENT SESSION\n${parts.join(' ')}`;
}
export function clearSession(taskId) {
    try {
        const file = sessionFile(taskId);
        if (fs.existsSync(file))
            fs.unlinkSync(file);
    }
    catch {
        // Fail open.
    }
}
export function pruneSessions() {
    try {
        const dir = sessionDir();
        if (!fs.existsSync(dir))
            return;
        const cutoff = Date.now() - RETENTION_MS;
        for (const name of fs.readdirSync(dir)) {
            const file = path.join(dir, name);
            try {
                if (fs.statSync(file).mtimeMs < cutoff)
                    fs.unlinkSync(file);
            }
            catch { /* skip this one */ }
        }
    }
    catch {
        // Fail open.
    }
}
export function getSessionDir() {
    return sessionDir();
}
