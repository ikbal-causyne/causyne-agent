import fs from 'node:fs';
import path from 'node:path';
import { causyneHome } from './utils/paths.js';

export type AuditLogEvent = Record<string, unknown>;

export interface AuditLogEntry extends AuditLogEvent {
  ts: string;
}

const LOG_DIR = path.join(causyneHome(), 'logs');

export class AuditLog {
  logFile: string;

  constructor() {
    this.ensureLogDir();
    const date = new Date().toISOString().split('T')[0] || 'unknown';
    this.logFile = path.join(LOG_DIR, `audit-${date}.jsonl`);
  }

  ensureLogDir(): void {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }
  }

  log(eventData: AuditLogEvent): void {
    const entry: AuditLogEntry = {
      ts: new Date().toISOString(),
      ...eventData
    };

    // Append to file synchronously to ensure it writes before any potential crash
    try {
      fs.appendFileSync(this.logFile, JSON.stringify(entry) + '\n');
    } catch (e: unknown) {
      console.error('Failed to write audit log:', e);
    }
  }

  getRecentLogs(limit = 100): AuditLogEntry[] {
    if (!fs.existsSync(this.logFile)) return [];

    try {
      const content = fs.readFileSync(this.logFile, 'utf8');
      const lines = content.split('\n').filter(l => l.trim().length > 0);

      const parsed: AuditLogEntry[] = [];
      for (const line of lines.slice(-limit)) {
        try {
          const item: unknown = JSON.parse(line);
          if (item && typeof item === 'object' && !Array.isArray(item)) {
            parsed.push(item as AuditLogEntry);
          }
        } catch {
          // skip corrupt line
        }
      }
      return parsed;
    } catch (e: unknown) {
      console.error('Failed to read audit log:', e);
      return [];
    }
  }
}

export const auditLog = new AuditLog();
