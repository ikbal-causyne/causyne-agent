import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { causyneHome } from './utils/paths.js';

export interface EmbodimentSessionState {
  app?: string;
  lastTreeDigest?: string | null;
  lastTreeNodeCount?: number;
  observedAt?: string;
  lastActions?: string[];
  actedAt?: string;
}

function sessionDir(): string {
  return path.join(causyneHome(), 'embodiment');
}
const RETENTION_MS = 24 * 60 * 60 * 1000;

export function isSessionTrackingEnabled(): boolean {
  return process.env.CAUSYNE_EMBODIMENT_SESSION !== '0';
}

function ensureSessionDir(): void {
  fs.mkdirSync(sessionDir(), { recursive: true, mode: 0o700 });
}

function safeTaskId(taskId: unknown): string {
  const cleaned = String(taskId || 'default').replace(/[^a-zA-Z0-9_-]/g, '');
  return cleaned === '' ? 'default' : cleaned.slice(0, 64);
}

function sessionFile(taskId: unknown): string {
  return path.join(sessionDir(), `${safeTaskId(taskId)}.json`);
}

function digestOf(text: unknown): string {
  let hash = 5381;
  const source = String(text || '');
  for (let i = 0; i < source.length; i++) {
    hash = ((hash * 33) ^ source.charCodeAt(i)) >>> 0;
  }
  return `${hash.toString(16)}:${source.length}`;
}

function writeSessionAtomic(file: string, state: EmbodimentSessionState): void {
  ensureSessionDir();
  try {
    if (fs.lstatSync(file).isSymbolicLink()) return;
  } catch {
    // file may not exist yet
  }
  const body = JSON.stringify(state, null, 2);
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, body, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, file);
  } catch (err: unknown) {
    try { fs.unlinkSync(temporary); } catch { /* ignore cleanup error */ }
    throw err;
  }
}

function cleanSessionText(value: unknown, maxLen = 120): string {
  // eslint-disable-next-line no-control-regex
  return String(value ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, maxLen);
}

export function recordObservation(taskId: unknown, app: string, treeText: unknown): void {
  if (!isSessionTrackingEnabled()) return;
  try {
    const previous = readSession(taskId) || {};
    const cleanApp = cleanSessionText(app, 120);
    const state: EmbodimentSessionState = {
      ...previous,
      app: cleanApp || previous.app || '',
      lastTreeDigest: digestOf(treeText),
      lastTreeNodeCount: String(treeText || '').split('\n').filter(Boolean).length,
      observedAt: new Date().toISOString()
    };
    writeSessionAtomic(sessionFile(taskId), state);
  } catch {
    // Fail open: a lost session record must never fail the task.
  }
}

export function recordActuation(taskId: unknown, app: string, verbs: readonly unknown[]): void {
  if (!isSessionTrackingEnabled()) return;
  try {
    const previous = readSession(taskId) || {};
    const cleanApp = cleanSessionText(app, 120);
    const state: EmbodimentSessionState = {
      ...previous,
      app: cleanApp || previous.app || '',
      lastActions: Array.isArray(verbs) ? verbs.map(v => cleanSessionText(v, 120)).filter(Boolean).slice(0, 12) : [],
      lastTreeDigest: null,
      actedAt: new Date().toISOString()
    };
    writeSessionAtomic(sessionFile(taskId), state);
  } catch {
    // Fail open.
  }
}

export function readSession(taskId: unknown): EmbodimentSessionState | null {
  try {
    const file = sessionFile(taskId);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.size > 256 * 1024) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as EmbodimentSessionState
      : null;
  } catch {
    return null;
  }
}

export function describeSession(taskId: unknown): string {
  const state = readSession(taskId);
  if (!state || (!state.app && !state.lastActions)) return '';

  const parts: string[] = [];
  parts.push(`You were driving ${state.app ? `"${state.app}"` : 'the frontmost application'} before this session resumed.`);
  if (Array.isArray(state.lastActions) && state.lastActions.length > 0) {
    parts.push(`Your last actions were: ${state.lastActions.join(', ')}.`);
    parts.push('You do NOT know whether they landed — the screen may have changed while you were gone.');
  }
  parts.push('Call ax_snapshot before acting again, and compare what you see to what you expected.');
  return `\n\n◆ EMBODIMENT SESSION\n${parts.join(' ')}`;
}

export function clearSession(taskId: unknown): void {
  try {
    const file = sessionFile(taskId);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch {
    // Fail open.
  }
}

export function pruneSessions(): void {
  try {
    const dir = sessionDir();
    if (!fs.existsSync(dir)) return;
    const cutoff = Date.now() - RETENTION_MS;
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
      } catch { /* skip this one */ }
    }
  } catch {
    // Fail open.
  }
}

export function getSessionDir(): string {
  return sessionDir();
}
