import fs from 'node:fs';
import path from 'node:path';
import { causyneHome } from './utils/paths.js';
const LOG_DIR = path.join(causyneHome(), 'logs');
export class AuditLog {
    logFile;
    constructor() {
        this.ensureLogDir();
        const date = new Date().toISOString().split('T')[0] || 'unknown';
        this.logFile = path.join(LOG_DIR, `audit-${date}.jsonl`);
    }
    ensureLogDir() {
        if (!fs.existsSync(LOG_DIR)) {
            fs.mkdirSync(LOG_DIR, { recursive: true });
        }
    }
    log(eventData) {
        const entry = {
            ts: new Date().toISOString(),
            ...eventData
        };
        // Append to file synchronously to ensure it writes before any potential crash
        try {
            fs.appendFileSync(this.logFile, JSON.stringify(entry) + '\n');
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
