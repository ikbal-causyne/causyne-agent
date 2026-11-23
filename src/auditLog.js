import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { causyneHome } from './utils/paths.js';
import { redactTextSecrets } from './providers/byokHttp.js';
const AUDIT_FILENAME_RE = /^audit-\d{4}-\d{2}-\d{2}\.jsonl$/;
const GENESIS_HASH = 'GENESIS';
const MAX_AUDIT_EXPORT_ENTRIES = 50_000;
const MAX_AUDIT_EXPORT_FILES = 365;
const CSV_COLUMNS = ['ts', 'event', 'taskId', 'tool', 'risk', 'dimension', 'rule', 'reason', 'details'];
const CSV_FIXED_KEYS = new Set(['ts', 'event', 'taskId', 'tool', 'risk', 'dimension', 'rule', 'reason']);
function canonicalizeValue(value, seen = new WeakSet()) {
    if (value === null || typeof value !== 'object') {
        return typeof value === 'bigint' ? value.toString() : value;
    }
    if (seen.has(value))
        return '[circular]';
    seen.add(value);
    try {
        if (Array.isArray(value)) {
            return value.map((item) => canonicalizeValue(item, seen));
        }
        const out = Object.create(null);
        for (const key of Object.keys(value).sort()) {
            if (key === '__proto__' || key === 'constructor' || key === 'prototype')
                continue;
            const v = value[key];
            if (v !== undefined) {
                out[key] = canonicalizeValue(v, seen);
            }
        }
        return { ...out };
    }
    finally {
        seen.delete(value);
    }
}
export function computeAuditEntryHash(prevHash, entry) {
    const payload = Object.create(null);
    for (const [k, v] of Object.entries(entry)) {
        if (k === 'entryHash' || k === '__proto__' || k === 'constructor' || k === 'prototype')
            continue;
        if (v !== undefined)
            payload[k] = v;
    }
    payload.prevHash = prevHash;
    const canonical = JSON.stringify(canonicalizeValue(payload));
    return crypto.createHash('sha256').update(prevHash).update('\n').update(canonical).digest('hex');
}
function readTailSafeUtf8(filePath, size, maxBytes) {
    if (size <= maxBytes) {
        return fs.readFileSync(filePath, 'utf8');
    }
    const buf = Buffer.alloc(maxBytes);
    const fd = fs.openSync(filePath, 'r');
    let bytesRead = 0;
    try {
        bytesRead = fs.readSync(fd, buf, 0, maxBytes, size - maxBytes);
    }
    finally {
        fs.closeSync(fd);
    }
    const slice = buf.subarray(0, bytesRead);
    // Drop the partial leading line so we never slice mid-UTF-8 codepoint or mid-JSON object.
    const firstNewline = slice.indexOf(0x0a);
    if (firstNewline === -1)
        return '';
    return slice.subarray(firstNewline + 1).toString('utf8');
}
function ocsfSeverityId(entry) {
    const risk = String(entry.risk ?? '').toLowerCase();
    const event = String(entry.event ?? '').toLowerCase();
    if (risk === 'extreme' || risk === 'critical' || event.includes('blocked') || event.includes('killed') || event.includes('violation')) {
        return 4; // High
    }
    if (risk === 'high' || risk === 'dangerous' || event.includes('denied') || event.includes('error')) {
        return 3; // Medium
    }
    if (risk === 'medium' || event.includes('warn')) {
        return 2; // Low
    }
    return 1; // Informational
}
function toOcsfEvent(entry) {
    const parsedTime = Date.parse(String(entry.ts ?? ''));
    const timeMs = Number.isFinite(parsedTime) ? parsedTime : Date.now();
    const eventName = typeof entry.event === 'string' && entry.event.trim() ? entry.event.trim() : 'audit_event';
    const extras = Object.create(null);
    for (const [k, v] of Object.entries(entry)) {
        if (k === '__proto__' || k === 'constructor' || k === 'prototype')
            continue;
        extras[k] = v;
    }
    return {
        metadata: {
            version: '1.1.0',
            product: { name: 'Causyne Agent', vendor_name: 'Causyne' },
            ...(typeof entry.entryHash === 'string' ? { uid: entry.entryHash } : {})
        },
        category_uid: 6,
        category_name: 'Application Activity',
        class_uid: 6003,
        class_name: 'API Activity',
        activity_id: 99,
        activity_name: eventName,
        severity_id: ocsfSeverityId(entry),
        time: timeMs,
        status: String(entry.event ?? '').includes('blocked') || String(entry.event ?? '').includes('denied') ? 'Failure' : 'Success',
        message: typeof entry.reason === 'string' ? redactTextSecrets(entry.reason) : eventName,
        actor: {
            user: {
                name: typeof entry.actor === 'string' && entry.actor.trim()
                    ? entry.actor.trim()
                    : (os.userInfo().username || 'local')
            },
            ...(typeof entry.sessionId === 'string' ? { session: { uid: entry.sessionId } } : {})
        },
        api: {
            operation: typeof entry.tool === 'string' ? entry.tool : eventName,
            ...(typeof entry.provider === 'string' ? { service: { name: entry.provider } } : {})
        },
        unmapped: { ...extras }
    };
}
function neutralizeCsvFormula(text) {
    if (!text)
        return '';
    const first = text.charCodeAt(0);
    if (first === 61 || first === 43 || first === 45 || first === 64 || first === 9 || first === 13) {
        return `'${text}`;
    }
    const trimmed = text.trimStart();
    if (trimmed.length > 0 && trimmed.length !== text.length) {
        const trimmedFirst = trimmed.charCodeAt(0);
        if (trimmedFirst === 61 || trimmedFirst === 43 || trimmedFirst === 45 || trimmedFirst === 64) {
            return `'${text}`;
        }
    }
    return text;
}
function encodeCsvCell(value) {
    if (value === null || value === undefined)
        return '';
    let raw;
    if (typeof value === 'number' || typeof value === 'boolean') {
        raw = String(value);
    }
    else if (typeof value === 'string') {
        raw = neutralizeCsvFormula(redactTextSecrets(value));
    }
    else {
        try {
            raw = neutralizeCsvFormula(redactTextSecrets(JSON.stringify(value) ?? ''));
        }
        catch {
            raw = neutralizeCsvFormula(redactTextSecrets(String(value)));
        }
    }
    if (raw.includes(',') || raw.includes('"') || raw.includes('\n') || raw.includes('\r')) {
        return `"${raw.replace(/"/g, '""')}"`;
    }
    return raw;
}
export function formatAuditExport(entries, format = 'jsonl') {
    if (format === 'csv') {
        const lines = [CSV_COLUMNS.join(',')];
        for (const entry of entries) {
            const extras = Object.create(null);
            let hasExtras = false;
            for (const [k, v] of Object.entries(entry)) {
                if (CSV_FIXED_KEYS.has(k) || k === '__proto__' || k === 'constructor' || k === 'prototype')
                    continue;
                extras[k] = v;
                hasExtras = true;
            }
            const row = [
                encodeCsvCell(entry.ts),
                encodeCsvCell(entry.event),
                encodeCsvCell(entry.taskId),
                encodeCsvCell(entry.tool),
                encodeCsvCell(entry.risk),
                encodeCsvCell(entry.dimension),
                encodeCsvCell(entry.rule),
                encodeCsvCell(entry.reason),
                encodeCsvCell(hasExtras ? extras : '')
            ];
            lines.push(row.join(','));
        }
        return lines.join('\n') + '\n';
    }
    if (format === 'ocsf') {
        if (entries.length === 0)
            return '';
        return entries.map((entry) => redactTextSecrets(JSON.stringify(toOcsfEvent(entry)))).join('\n') + '\n';
    }
    if (entries.length === 0)
        return '';
    return entries.map((entry) => redactTextSecrets(JSON.stringify(entry))).join('\n') + '\n';
}
function sanitizeAuditValue(value, depth = 0, seen = new WeakSet()) {
    if (value === null || value === undefined)
        return value;
    if (typeof value === 'string')
        return redactTextSecrets(value);
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
const MAX_AUDIT_ENTRY_CHARS = 32_768;
const MAX_AUDIT_READ_BYTES = 8 * 1024 * 1024;
function resolveLogDir() {
    return path.join(causyneHome(), 'logs');
}
export class AuditLog {
    logFile;
    lastHashes = new Map();
    defaultContext = {};
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
    setContext(ctx) {
        if (!ctx || typeof ctx !== 'object') {
            this.defaultContext = {};
            return;
        }
        this.defaultContext = {
            ...(typeof ctx.actor === 'string' && ctx.actor.trim() ? { actor: ctx.actor.trim() } : {}),
            ...(typeof ctx.sessionId === 'string' && ctx.sessionId.trim() ? { sessionId: ctx.sessionId.trim() } : {}),
            ...(typeof ctx.workspace === 'string' && ctx.workspace.trim() ? { workspace: ctx.workspace.trim() } : {}),
            ...(typeof ctx.provider === 'string' && ctx.provider.trim() ? { provider: ctx.provider.trim() } : {})
        };
    }
    resolvePreviousHash(target) {
        const cached = this.lastHashes.get(target);
        if (cached)
            return cached;
        try {
            const stat = fs.lstatSync(target);
            if (stat.isSymbolicLink() || !stat.isFile() || stat.size === 0) {
                return GENESIS_HASH;
            }
            const tail = readTailSafeUtf8(target, stat.size, 65_536);
            const lines = tail.split('\n').map((l) => l.trim()).filter(Boolean);
            for (let i = lines.length - 1; i >= 0; i--) {
                try {
                    const parsed = JSON.parse(lines[i]);
                    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                        const hash = parsed.entryHash;
                        if (typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)) {
                            this.lastHashes.set(target, hash);
                            return hash;
                        }
                        return GENESIS_HASH;
                    }
                }
                catch {
                    continue;
                }
            }
        }
        catch {
            // File absent or unreadable; start fresh chain
        }
        return GENESIS_HASH;
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
        const normalized = eventData && typeof eventData === 'object' && !Array.isArray(eventData)
            ? eventData
            : { message: eventData == null ? '' : String(eventData) };
        const sanitized = sanitizeAuditValue(normalized);
        const contextEnvelope = {};
        if (this.defaultContext.actor && !('actor' in sanitized))
            contextEnvelope.actor = this.defaultContext.actor;
        if (this.defaultContext.sessionId && !('sessionId' in sanitized))
            contextEnvelope.sessionId = this.defaultContext.sessionId;
        if (this.defaultContext.workspace && !('workspace' in sanitized))
            contextEnvelope.workspace = this.defaultContext.workspace;
        if (this.defaultContext.provider && !('provider' in sanitized))
            contextEnvelope.provider = this.defaultContext.provider;
        const entry = {
            ts: new Date().toISOString(),
            ...contextEnvelope,
            ...(sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized) ? sanitized : {})
        };
        delete entry.prevHash;
        delete entry.entryHash;
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
            const prevHash = this.resolvePreviousHash(target);
            let chainedEntry = {
                ...entry,
                prevHash,
                entryHash: computeAuditEntryHash(prevHash, entry)
            };
            let serialized = JSON.stringify(chainedEntry);
            if (serialized.length > MAX_AUDIT_ENTRY_CHARS) {
                const truncatedBase = {
                    ts: entry.ts,
                    truncated: true,
                    preview: serialized.slice(0, MAX_AUDIT_ENTRY_CHARS - 384)
                };
                chainedEntry = {
                    ...truncatedBase,
                    prevHash,
                    entryHash: computeAuditEntryHash(prevHash, truncatedBase)
                };
                serialized = JSON.stringify(chainedEntry);
            }
            fs.appendFileSync(target, serialized + '\n', { encoding: 'utf8', mode: 0o600 });
            if (typeof chainedEntry.entryHash === 'string') {
                this.lastHashes.set(target, chainedEntry.entryHash);
            }
            if (process.platform !== 'win32') {
                try {
                    fs.chmodSync(target, 0o600);
                }
                catch { /* ignore */ }
            }
        }
        catch (e) {
            console.error('Failed to write audit log:', e);
        }
    }
    getRecentLogs(limit = 100) {
        const safeLimit = typeof limit === 'number' && Number.isFinite(limit)
            ? Math.max(1, Math.min(10_000, Math.floor(limit)))
            : 100;
        const target = this.currentLogFile();
        if (!fs.existsSync(target))
            return [];
        try {
            const stat = fs.lstatSync(target);
            if (stat.isSymbolicLink() || !stat.isFile() || stat.size === 0)
                return [];
            const content = readTailSafeUtf8(target, stat.size, MAX_AUDIT_READ_BYTES);
            const lines = content.split('\n').filter(l => l.trim().length > 0);
            const parsed = [];
            for (const line of lines.slice(-safeLimit)) {
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
    readAuditLogs(options = {}) {
        const safeLimit = typeof options.limit === 'number' && Number.isFinite(options.limit)
            ? Math.max(1, Math.min(MAX_AUDIT_EXPORT_ENTRIES, Math.floor(options.limit)))
            : 1000;
        const safeDays = typeof options.days === 'number' && Number.isFinite(options.days)
            ? Math.max(1, Math.min(MAX_AUDIT_EXPORT_FILES, Math.floor(options.days)))
            : null;
        const eventFilter = typeof options.event === 'string' && options.event.trim()
            ? options.event.trim().toLowerCase()
            : null;
        const toolFilter = typeof options.tool === 'string' && options.tool.trim()
            ? options.tool.trim().toLowerCase()
            : null;
        const dir = resolveLogDir();
        let dirStat;
        try {
            dirStat = fs.lstatSync(dir);
        }
        catch {
            return [];
        }
        if (dirStat.isSymbolicLink() || !dirStat.isDirectory())
            return [];
        let files;
        try {
            files = fs.readdirSync(dir)
                .filter((name) => AUDIT_FILENAME_RE.test(name))
                .sort();
        }
        catch {
            return [];
        }
        if (safeDays !== null) {
            const cutoff = new Date(Date.now() - (safeDays - 1) * 86_400_000).toISOString().slice(0, 10);
            files = files.filter((name) => name.slice(6, 16) >= cutoff);
        }
        if (files.length > MAX_AUDIT_EXPORT_FILES) {
            files = files.slice(-MAX_AUDIT_EXPORT_FILES);
        }
        const entries = [];
        for (const file of files) {
            const fullPath = path.join(dir, file);
            try {
                const stat = fs.lstatSync(fullPath);
                if (stat.isSymbolicLink() || !stat.isFile() || stat.size === 0)
                    continue;
                const content = readTailSafeUtf8(fullPath, stat.size, MAX_AUDIT_READ_BYTES);
                for (const rawLine of content.split('\n')) {
                    const line = rawLine.trim();
                    if (!line)
                        continue;
                    try {
                        const parsed = JSON.parse(line);
                        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
                            continue;
                        const item = parsed;
                        if (eventFilter && String(item.event ?? '').toLowerCase() !== eventFilter)
                            continue;
                        if (toolFilter && String(item.tool ?? '').toLowerCase() !== toolFilter)
                            continue;
                        entries.push(item);
                    }
                    catch {
                        // skip malformed line
                    }
                }
            }
            catch {
                continue;
            }
        }
        return entries.length > safeLimit ? entries.slice(-safeLimit) : entries;
    }
    verifyAuditChain(options = {}) {
        const errors = [];
        let filesChecked = 0;
        let entriesVerified = 0;
        let legacyEntries = 0;
        const targetFiles = [];
        if (typeof options.file === 'string' && options.file.trim()) {
            targetFiles.push(path.resolve(options.file.trim()));
        }
        else {
            const dir = resolveLogDir();
            try {
                const dirStat = fs.lstatSync(dir);
                if (!dirStat.isSymbolicLink() && dirStat.isDirectory()) {
                    let files = fs.readdirSync(dir).filter((name) => AUDIT_FILENAME_RE.test(name)).sort();
                    if (typeof options.days === 'number' && Number.isFinite(options.days) && options.days > 0) {
                        const safeDays = Math.max(1, Math.min(MAX_AUDIT_EXPORT_FILES, Math.floor(options.days)));
                        const cutoff = new Date(Date.now() - (safeDays - 1) * 86_400_000).toISOString().slice(0, 10);
                        files = files.filter((name) => name.slice(6, 16) >= cutoff);
                    }
                    for (const f of files)
                        targetFiles.push(path.join(dir, f));
                }
            }
            catch {
                // No audit directory yet
            }
        }
        for (const fullPath of targetFiles) {
            try {
                const stat = fs.lstatSync(fullPath);
                if (stat.isSymbolicLink() || !stat.isFile()) {
                    errors.push({ file: path.basename(fullPath), line: 0, reason: 'Refused symlink or non-regular file' });
                    continue;
                }
                filesChecked++;
                const raw = fs.readFileSync(fullPath, 'utf8');
                const lines = raw.split('\n');
                let expectedPrev = GENESIS_HASH;
                let chainStarted = false;
                for (let i = 0; i < lines.length; i++) {
                    const trimmed = lines[i].trim();
                    if (!trimmed)
                        continue;
                    const lineNum = i + 1;
                    let parsed;
                    try {
                        parsed = JSON.parse(trimmed);
                    }
                    catch {
                        errors.push({ file: path.basename(fullPath), line: lineNum, reason: 'Malformed JSON line' });
                        continue;
                    }
                    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                        errors.push({ file: path.basename(fullPath), line: lineNum, reason: 'Non-object audit record' });
                        continue;
                    }
                    const rec = parsed;
                    const hasHash = typeof rec.entryHash === 'string' && rec.entryHash.length > 0;
                    const hasPrev = typeof rec.prevHash === 'string' && rec.prevHash.length > 0;
                    if (!hasHash && !hasPrev) {
                        if (chainStarted) {
                            errors.push({ file: path.basename(fullPath), line: lineNum, reason: 'Unchained entry inserted after hash chain started' });
                        }
                        else {
                            legacyEntries++;
                        }
                        continue;
                    }
                    chainStarted = true;
                    if (rec.prevHash !== expectedPrev) {
                        errors.push({
                            file: path.basename(fullPath),
                            line: lineNum,
                            reason: `Broken hash chain: expected prevHash ${expectedPrev.slice(0, 12)}..., got ${String(rec.prevHash ?? '').slice(0, 12)}...`
                        });
                    }
                    else {
                        const recomputed = computeAuditEntryHash(expectedPrev, rec);
                        if (rec.entryHash !== recomputed) {
                            errors.push({
                                file: path.basename(fullPath),
                                line: lineNum,
                                reason: 'Tampered audit entry: SHA-256 entryHash mismatch'
                            });
                        }
                        else {
                            entriesVerified++;
                        }
                    }
                    if (typeof rec.entryHash === 'string' && rec.entryHash.length > 0) {
                        expectedPrev = rec.entryHash;
                    }
                }
            }
            catch (err) {
                errors.push({
                    file: path.basename(fullPath),
                    line: 0,
                    reason: err instanceof Error ? err.message : String(err)
                });
            }
        }
        return {
            ok: errors.length === 0,
            filesChecked,
            entriesVerified,
            legacyEntries,
            errors
        };
    }
    pruneAuditLogs(retentionDays) {
        const safeDays = typeof retentionDays === 'number' && Number.isFinite(retentionDays)
            ? Math.max(1, Math.min(3650, Math.floor(retentionDays)))
            : 30;
        const cutoff = new Date(Date.now() - (safeDays - 1) * 86_400_000).toISOString().slice(0, 10);
        const dir = resolveLogDir();
        const deleted = [];
        let kept = 0;
        let dirStat;
        try {
            dirStat = fs.lstatSync(dir);
        }
        catch {
            return { deleted, kept };
        }
        if (dirStat.isSymbolicLink() || !dirStat.isDirectory())
            return { deleted, kept };
        let files;
        try {
            files = fs.readdirSync(dir).filter((name) => AUDIT_FILENAME_RE.test(name)).sort();
        }
        catch {
            return { deleted, kept };
        }
        for (const name of files) {
            const dateStr = name.slice(6, 16);
            const fullPath = path.join(dir, name);
            if (dateStr < cutoff) {
                try {
                    const stat = fs.lstatSync(fullPath);
                    if (!stat.isSymbolicLink() && stat.isFile()) {
                        fs.unlinkSync(fullPath);
                        this.lastHashes.delete(fullPath);
                        deleted.push(name);
                        continue;
                    }
                }
                catch {
                    // ignore unlink failures
                }
            }
            kept++;
        }
        return { deleted, kept };
    }
}
export const auditLog = new AuditLog();
