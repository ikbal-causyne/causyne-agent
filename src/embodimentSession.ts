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

const SESSION_DIR = path.join(causyneHome(), 'embodiment');
const RETENTION_MS = 24 * 60 * 60 * 1000;

export function isSessionTrackingEnabled(): boolean {
  return process.env.CAUSYNE_EMBODIMENT_SESSION !== '0';
}

function ensureSessionDir(): void {
  if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
  }
}

function safeTaskId(taskId: unknown): string {
  const cleaned = String(taskId || 'default').replace(/[^a-zA-Z0-9_-]/g, '');
  return cleaned === '' ? 'default' : cleaned.slice(0, 64);
}

function sessionFile(taskId: unknown): string {
  return path.join(SESSION_DIR, `${safeTaskId(taskId)}.json`);
}

function digestOf(text: unknown): string {
  let hash = 5381;
  const source = String(text || '');
  for (let i = 0; i < source.length; i++) {
    hash = ((hash * 33) ^ source.charCodeAt(i)) >>> 0;
  }
  return `${hash.toString(16)}:${source.length}`;
}

export function recordObservation(taskId: unknown, app: string, treeText: unknown): void {
  if (!isSessionTrackingEnabled()) return;
  try {
    ensureSessionDir();
    const previous = readSession(taskId) || {};
    const state: EmbodimentSessionState = {
      ...previous,
      app: app || previous.app || '',
      lastTreeDigest: digestOf(treeText),
      lastTreeNodeCount: String(treeText || '').split('\n').filter(Boolean).length,
      observedAt: new Date().toISOString()
    };
    fs.writeFileSync(sessionFile(taskId), JSON.stringify(state, null, 2), { mode: 0o600 });
  } catch {
    // Fail open: a lost session record must never fail the task.
  }
}

export function recordActuation(taskId: unknown, app: string, verbs: readonly unknown[]): void {
  if (!isSessionTrackingEnabled()) return;
  try {
    ensureSessionDir();
    const previous = readSession(taskId) || {};
    const state: EmbodimentSessionState = {
      ...previous,
      app: app || previous.app || '',
      lastActions: Array.isArray(verbs) ? verbs.map(v => String(v)).slice(0, 12) : [],
      lastTreeDigest: null,
      actedAt: new Date().toISOString()
    };
    fs.writeFileSync(sessionFile(taskId), JSON.stringify(state, null, 2), { mode: 0o600 });
  } catch {
    // Fail open.
  }
}

export function readSession(taskId: unknown): EmbodimentSessionState | null {
  try {
    const file = sessionFile(taskId);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8')) as EmbodimentSessionState;
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
    if (!fs.existsSync(SESSION_DIR)) return;
    const cutoff = Date.now() - RETENTION_MS;
    for (const name of fs.readdirSync(SESSION_DIR)) {
      const file = path.join(SESSION_DIR, name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
      } catch { /* skip this one */ }
    }
  } catch {
    // Fail open.
  }
}

export function getSessionDir(): string {
  return SESSION_DIR;
}
