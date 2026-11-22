import fs from 'node:fs';
import path from 'node:path';
import { causyneHome } from './utils/paths.js';
import { redactProviderSecrets } from './providers/byokHttp.js';

export type AuditLogEvent = Record<string, unknown>;

export interface AuditLogEntry extends AuditLogEvent {
  ts: string;
}

export type AuditExportFormat = 'jsonl' | 'csv';

export interface AuditExportOptions {
  days?: number | undefined;
  limit?: number | undefined;
  event?: string | undefined;
  tool?: string | undefined;
}

const AUDIT_FILENAME_RE = /^audit-\d{4}-\d{2}-\d{2}\.jsonl$/;
const MAX_AUDIT_EXPORT_ENTRIES = 50_000;
const MAX_AUDIT_EXPORT_FILES = 365;
const CSV_COLUMNS = ['ts', 'event', 'taskId', 'tool', 'risk', 'dimension', 'rule', 'reason', 'details'] as const;
const CSV_FIXED_KEYS = new Set<string>(['ts', 'event', 'taskId', 'tool', 'risk', 'dimension', 'rule', 'reason']);

function neutralizeCsvFormula(text: string): string {
  if (!text) return '';
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

function encodeCsvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let raw: string;
  if (typeof value === 'number' || typeof value === 'boolean') {
    raw = String(value);
  } else if (typeof value === 'string') {
    raw = neutralizeCsvFormula(redactProviderSecrets(value));
  } else {
    try {
      raw = neutralizeCsvFormula(redactProviderSecrets(JSON.stringify(value) ?? ''));
    } catch {
      raw = neutralizeCsvFormula(redactProviderSecrets(String(value)));
    }
  }
  if (raw.includes(',') || raw.includes('"') || raw.includes('\n') || raw.includes('\r')) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

export function formatAuditExport(
  entries: readonly AuditLogEntry[],
  format: AuditExportFormat = 'jsonl'
): string {
  if (format === 'csv') {
    const lines: string[] = [CSV_COLUMNS.join(',')];
    for (const entry of entries) {
      const extras: Record<string, unknown> = {};
      let hasExtras = false;
      for (const [k, v] of Object.entries(entry)) {
        if (CSV_FIXED_KEYS.has(k)) continue;
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
  if (entries.length === 0) return '';
  return entries.map((entry) => redactProviderSecrets(JSON.stringify(entry))).join('\n') + '\n';
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

  readAuditLogs(options: AuditExportOptions = {}): AuditLogEntry[] {
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
    let dirStat: fs.Stats;
    try {
      dirStat = fs.lstatSync(dir);
    } catch {
      return [];
    }
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) return [];

    let files: string[];
    try {
      files = fs.readdirSync(dir)
        .filter((name) => AUDIT_FILENAME_RE.test(name))
        .sort();
    } catch {
      return [];
    }
    if (safeDays !== null) {
      const cutoff = new Date(Date.now() - (safeDays - 1) * 86_400_000).toISOString().slice(0, 10);
      files = files.filter((name) => name.slice(6, 16) >= cutoff);
    }
    if (files.length > MAX_AUDIT_EXPORT_FILES) {
      files = files.slice(-MAX_AUDIT_EXPORT_FILES);
    }

    const entries: AuditLogEntry[] = [];
    for (const file of files) {
      const fullPath = path.join(dir, file);
      try {
        const stat = fs.lstatSync(fullPath);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.size === 0) continue;
        let content: string;
        if (stat.size > MAX_AUDIT_READ_BYTES) {
          const buf = Buffer.alloc(MAX_AUDIT_READ_BYTES);
          const fd = fs.openSync(fullPath, 'r');
          try {
            fs.readSync(fd, buf, 0, MAX_AUDIT_READ_BYTES, stat.size - MAX_AUDIT_READ_BYTES);
          } finally {
            fs.closeSync(fd);
          }
          content = buf.toString('utf8');
        } else {
          content = fs.readFileSync(fullPath, 'utf8');
        }
        for (const rawLine of content.split('\n')) {
          const line = rawLine.trim();
          if (!line) continue;
          try {
            const parsed: unknown = JSON.parse(line);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
            const item = parsed as AuditLogEntry;
            if (eventFilter && String(item.event ?? '').toLowerCase() !== eventFilter) continue;
            if (toolFilter && String(item.tool ?? '').toLowerCase() !== toolFilter) continue;
            entries.push(item);
          } catch {
            // skip malformed line
          }
        }
      } catch {
        continue;
      }
    }

    return entries.length > safeLimit ? entries.slice(-safeLimit) : entries;
  }
}

export const auditLog = new AuditLog();
