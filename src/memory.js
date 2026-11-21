import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { causyneHome } from './utils/paths.js';
import { redactProviderSecrets } from './providers/byokHttp.js';
import { formatMemoryContext, normalizeMemoryData, recordScopedFact } from './memory/scopedFacts.js';
function logMemoryError(action, error) {
    if (process.env.CAUSYNE_DEBUG !== '1')
        return;
    const msg = redactProviderSecrets(error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, ' ').slice(0, 512);
    process.stderr.write(`[causyne] Failed to ${action} memory.json: ${msg}\n`);
}
function memoryFilePath() {
    return path.join(causyneHome(), 'memory.json');
}
function initMemory() {
    const filePath = memoryFilePath();
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    try {
        fs.lstatSync(filePath);
    }
    catch (err) {
        if (err?.code === 'ENOENT') {
            fs.writeFileSync(filePath, JSON.stringify({ facts: [] }, null, 2), { flag: 'wx', mode: 0o600 });
        }
    }
    return filePath;
}
function writeMemoryAtomic(filePath, payload) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    try {
        if (fs.lstatSync(filePath).isSymbolicLink())
            return;
    }
    catch {
        // target may not exist yet
    }
    const serialized = JSON.stringify(payload, null, 2);
    const temporary = `${filePath}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
    try {
        const fd = fs.openSync(temporary, 'wx', 0o600);
        try {
            fs.writeFileSync(fd, serialized, 'utf8');
            fs.fsyncSync(fd);
        }
        finally {
            fs.closeSync(fd);
        }
        fs.renameSync(temporary, filePath);
    }
    catch (err) {
        try {
            fs.unlinkSync(temporary);
        }
        catch { /* ignore cleanup error */ }
        throw err;
    }
}
export function getMemory() {
    try {
        const filePath = initMemory();
        const MAX_MEMORY_BYTES = 4 * 1024 * 1024;
        const stat = fs.lstatSync(filePath);
        if (!stat.isFile() || stat.size > MAX_MEMORY_BYTES)
            return normalizeMemoryData({ facts: [] });
        const data = fs.readFileSync(filePath, 'utf-8');
        return normalizeMemoryData(JSON.parse(data));
    }
    catch (e) {
        logMemoryError('read', e);
        return normalizeMemoryData({ facts: [] });
    }
}
export function saveMemory(data) {
    try {
        const filePath = initMemory();
        writeMemoryAtomic(filePath, data);
    }
    catch (e) {
        logMemoryError('write', e);
    }
}
export function addFact(factStr, options = {}) {
    if (typeof factStr !== 'string' || !factStr.trim())
        return;
    const safeOptions = options && typeof options === 'object' ? options : {};
    const mem = getMemory();
    const { memory, alreadyKnown } = recordScopedFact(mem, factStr, safeOptions);
    if (!alreadyKnown || safeOptions.workspace) {
        saveMemory(memory);
    }
}
export function clearMemory() {
    try {
        const filePath = initMemory();
        writeMemoryAtomic(filePath, { facts: [], entries: [] });
    }
    catch (e) {
        logMemoryError('clear', e);
    }
}
export function getMemoryContextString(options) {
    const mem = getMemory();
    return formatMemoryContext(mem, options);
}
