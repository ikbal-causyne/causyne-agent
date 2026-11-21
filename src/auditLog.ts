import fs from 'node:fs';
import path from 'node:path';
import { causyneHome } from './utils/paths.js';
import { redactProviderSecrets } from './providers/byokHttp.js';

export type AuditLogEvent = Record<string, unknown>;

export interface AuditLogEntry extends AuditLogEvent {
  ts: string;
}

function sanitizeAuditValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactProviderSecrets(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (depth >= 6 || typeof value !== 'object') return '[omitted]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) {
    return value.slice(0, 64).map(item => sanitizeAuditValue(item, depth + 1, seen));
  }
  const out: Record<string, unknown> = {};
  let count = 0;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (count >= 64) break;
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    out[k] = sanitizeAuditValue(v, depth + 1, seen);
    count++;
  }
  return out;
}

const MAX_AUDIT_ENTRY_CHARS = 32_768;
const MAX_AUDIT_READ_BYTES = 8 * 1024 * 1024;

function resolveLogDir(): string {
  return path.join(causyneHome(), 'logs');
}

export class AuditLog {
  logFile: string;

  private currentLogFile(): string {
    const date = new Date().toISOString().split('T')[0] || 'unknown';
    this.logFile = path.join(resolveLogDir(), `audit-${date}.jsonl`);
    return this.logFile;
  }

  constructor() {
    this.logFile = path.join(resolveLogDir(), `audit-${new Date().toISOString().split('T')[0] || 'unknown'}.jsonl`);
    try { this.ensureLogDir(); } catch { /* fail open on init */ }
  }

  ensureLogDir(): void {
    const dir = resolveLogDir();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    } else {
      const stat = fs.lstatSync(dir);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error('Refusing to use symlink or non-directory as audit log directory');
      }
    }
    if (process.platform !== 'win32') {
      try { fs.chmodSync(dir, 0o700); } catch { /* ignore */ }
    }
  }

  log(eventData: unknown): void {
    const normalized = eventData && typeof eventData === 'object' && !Array.isArray(eventData)
      ? eventData
      : { message: eventData == null ? '' : String(eventData) };
    const sanitized = sanitizeAuditValue(normalized) as AuditLogEvent;
    const entry: AuditLogEntry = {
      ts: new Date().toISOString(),
      ...(sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized) ? sanitized : {})
    };

    try {
      this.ensureLogDir();
      const target = this.currentLogFile();
      try {
        const stat = fs.lstatSync(target);
        if (stat.isSymbolicLink() || !stat.isFile()) return;
      } catch (statErr: unknown) {
        const code = typeof statErr === 'object' && statErr !== null && 'code' in statErr ? String(statErr.code) : '';
        if (code !== 'ENOENT') return;
      }
      let serialized = JSON.stringify(entry);
      if (serialized.length > MAX_AUDIT_ENTRY_CHARS) {
        serialized = JSON.stringify({
          ts: entry.ts,
          truncated: true,
          preview: serialized.slice(0, MAX_AUDIT_ENTRY_CHARS - 256)
        });
      }
      fs.appendFileSync(target, serialized + '\n', { encoding: 'utf8', mode: 0o600 });
      if (process.platform !== 'win32') {
        try { fs.chmodSync(target, 0o600); } catch { /* ignore */ }
      }
    } catch (e: unknown) {
      console.error('Failed to write audit log:', e);
    }
  }

  getRecentLogs(limit = 100): AuditLogEntry[] {
    const safeLimit = typeof limit === 'number' && Number.isFinite(limit)
      ? Math.max(1, Math.min(10_000, Math.floor(limit)))
      : 100;
    const target = this.currentLogFile();
    if (!fs.existsSync(target)) return [];

    try {
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size === 0) return [];
      let content: string;
      if (stat.size > MAX_AUDIT_READ_BYTES) {
        const buf = Buffer.alloc(MAX_AUDIT_READ_BYTES);
        const fd = fs.openSync(target, 'r');
        try {
          fs.readSync(fd, buf, 0, MAX_AUDIT_READ_BYTES, stat.size - MAX_AUDIT_READ_BYTES);
        } finally {
          fs.closeSync(fd);
        }
        content = buf.toString('utf8');
      } else {
        content = fs.readFileSync(target, 'utf8');
      }
      const lines = content.split('\n').filter(l => l.trim().length > 0);

      const parsed: AuditLogEntry[] = [];
      for (const line of lines.slice(-safeLimit)) {
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
