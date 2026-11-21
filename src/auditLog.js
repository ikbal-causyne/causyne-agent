import fs from 'node:fs';
import path from 'node:path';
import { causyneHome } from './utils/paths.js';
import { redactProviderSecrets } from './providers/byokHttp.js';
function sanitizeAuditValue(value, depth = 0, seen = new WeakSet()) {
    if (value === null || value === undefined)
        return value;
    if (typeof value === 'string')
        return redactProviderSecrets(value);
    if (typeof value === 'number' || typeof value === 'boolean')
        return value;
    if (typeof value === 'bigint')
        return value.toString();
    if (depth >= 6 || typeof value !== 'object')
        return '[omitted]';
    if (seen.has(value))
        return '[circular]';
    seen.add(value);
    if (Array.isArray(value)) {
        return value.slice(0, 64).map(item => sanitizeAuditValue(item, depth + 1, seen));
    }
    const out = {};
    let count = 0;
    for (const [k, v] of Object.entries(value)) {
        if (count >= 64)
            break;
        if (k === '__proto__' || k === 'constructor' || k === 'prototype')
            continue;
        out[k] = sanitizeAuditValue(v, depth + 1, seen);
        count++;
    }
    return out;
}
function resolveLogDir() {
    return path.join(causyneHome(), 'logs');
}
export class AuditLog {
    logFile;
    currentLogFile() {
        const date = new Date().toISOString().split('T')[0] || 'unknown';
        this.logFile = path.join(resolveLogDir(), `audit-${date}.jsonl`);
        return this.logFile;
    }
    constructor() {
        this.logFile = path.join(resolveLogDir(), `audit-${new Date().toISOString().split('T')[0] || 'unknown'}.jsonl`);
        try {
            this.ensureLogDir();
        }
        catch { /* fail open on init */ }
    }
    ensureLogDir() {
        const dir = resolveLogDir();
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        }
        else {
            const stat = fs.lstatSync(dir);
            if (stat.isSymbolicLink() || !stat.isDirectory()) {
                throw new Error('Refusing to use symlink or non-directory as audit log directory');
            }
        }
        if (process.platform !== 'win32') {
            try {
                fs.chmodSync(dir, 0o700);
            }
            catch { /* ignore */ }
        }
    }
    log(eventData) {
        const sanitized = sanitizeAuditValue(eventData);
        const entry = {
            ts: new Date().toISOString(),
            ...(sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized) ? sanitized : {})
        };
        try {
            this.ensureLogDir();
            const target = this.currentLogFile();
            try {
                const stat = fs.lstatSync(target);
                if (stat.isSymbolicLink() || !stat.isFile())
                    return;
            }
            catch (statErr) {
                const code = typeof statErr === 'object' && statErr !== null && 'code' in statErr ? String(statErr.code) : '';
                if (code !== 'ENOENT')
                    return;
            }
            fs.appendFileSync(target, JSON.stringify(entry) + '\n', { encoding: 'utf8', mode: 0o600 });
        }
        catch (e) {
            console.error('Failed to write audit log:', e);
        }
    }
    getRecentLogs(limit = 100) {
        if (!fs.existsSync(this.logFile))
            return [];
        try {
            const content = fs.readFileSync(this.logFile, 'utf8');
            const lines = content.split('\n').filter(l => l.trim().length > 0);
            const parsed = [];
            for (const line of lines.slice(-limit)) {
                try {
                    const item = JSON.parse(line);
                    if (item && typeof item === 'object' && !Array.isArray(item)) {
                        parsed.push(item);
                    }
                }
                catch {
                    // skip corrupt line
                }
            }
            return parsed;
        }
        catch (e) {
            console.error('Failed to read audit log:', e);
            return [];
        }
    }
}
export const auditLog = new AuditLog();
