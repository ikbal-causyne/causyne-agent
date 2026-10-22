import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { causyneHome } from './utils/paths.js';

export interface SessionMessage extends Record<string, unknown> {
  role: string;
  content?: unknown;
}

export interface SessionRecord {
  id: string;
  workspace: string;
  workspaceKey: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: SessionMessage[];
}

interface SessionCreatedEvent {
  version: 1;
  type: 'session.created';
  at: number;
  session: Omit<SessionRecord, 'messages' | 'updatedAt'>;
}

interface MessagesAppendedEvent {
  version: 1;
  type: 'messages.appended';
  at: number;
  messages: SessionMessage[];
  title?: string;
}

interface MessagesReplacedEvent {
  version: 1;
  type: 'messages.replaced';
  at: number;
  messages: SessionMessage[];
  title?: string;
}

interface MessagesWindowedEvent {
  version: 1;
  type: 'messages.windowed';
  at: number;
  dropPrefix: number;
  messages: SessionMessage[];
  title?: string;
}

type SessionEvent = SessionCreatedEvent | MessagesAppendedEvent | MessagesReplacedEvent | MessagesWindowedEvent;

export const SESSION_DIR = path.join(causyneHome(), 'sessions');
const LEGACY_HISTORY = path.join(causyneHome(), 'memory', 'chat_history.json');
const POINTER_FILE = path.join(SESSION_DIR, 'active.json');
export const RESUME_WINDOW_MS = 12 * 60 * 60 * 1000;
export const MAX_SESSIONS = 50;
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const MAX_EVENT_BYTES = 8 * 1024 * 1024;

function ensureDir(): void {
  if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
}

function safeSessionId(id: unknown): string {
  return String(id ?? '').replace(/[^a-zA-Z0-9_-]/g, '');
}

function workspaceKey(workspace: unknown): string {
  return crypto.createHash('sha256').update(String(workspace ?? '')).digest('hex').slice(0, 12);
}

export function sessionTranscriptFile(id: unknown): string {
  return path.join(SESSION_DIR, `${safeSessionId(id)}.jsonl`);
}

function legacySessionFile(id: unknown): string {
  return path.join(SESSION_DIR, `${safeSessionId(id)}.json`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validMessage(value: unknown): value is SessionMessage {
  return isObject(value) && typeof value.role === 'string' && value.role.length > 0;
}

function validMessages(value: unknown): value is SessionMessage[] {
  return Array.isArray(value) && value.every(validMessage);
}

function parseEvent(value: unknown): SessionEvent | null {
  if (!isObject(value) || value.version !== 1 || typeof value.type !== 'string' || typeof value.at !== 'number') return null;
  if (value.type === 'session.created') {
    const session = value.session;
    if (!isObject(session)
      || typeof session.id !== 'string'
      || typeof session.workspace !== 'string'
      || typeof session.workspaceKey !== 'string'
      || typeof session.title !== 'string'
      || typeof session.createdAt !== 'number') return null;
    return value as unknown as SessionCreatedEvent;
  }
  if (value.type === 'messages.appended') {
    if (!validMessages(value.messages)) return null;
    if (value.title !== undefined && typeof value.title !== 'string') return null;
    return value as unknown as MessagesAppendedEvent;
  }
  if (value.type === 'messages.replaced') {
    if (!validMessages(value.messages)) return null;
    if (value.title !== undefined && typeof value.title !== 'string') return null;
    return value as unknown as MessagesReplacedEvent;
  }
  if (value.type === 'messages.windowed') {
    if (!Number.isInteger(value.dropPrefix) || Number(value.dropPrefix) < 0 || !validMessages(value.messages)) return null;
    if (value.title !== undefined && typeof value.title !== 'string') return null;
    return value as unknown as MessagesWindowedEvent;
  }
  return null;
}

function projectTranscript(text: string): SessionRecord | null {
  const trailingNewline = text.endsWith('\n');
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  let session: SessionRecord | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined || line.trim() === '') continue;
    if (Buffer.byteLength(line, 'utf8') > MAX_EVENT_BYTES) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      // O_APPEND can still be interrupted between bytes. Retain complete events
      // before a torn final line; never guess around corruption in the middle.
      if (index === lines.length - 1 && !trailingNewline) break;
      return null;
    }
    const event = parseEvent(raw);
    if (!event) return null;
    if (event.type === 'session.created') {
      if (session) return null;
      session = { ...event.session, updatedAt: event.at, messages: [] };
      continue;
    }
    if (!session) return null;
    if (event.type === 'messages.appended') session.messages.push(...event.messages);
    else if (event.type === 'messages.replaced') session.messages = event.messages.slice();
    else {
      if (event.dropPrefix > session.messages.length) return null;
      session.messages = session.messages.slice(event.dropPrefix).concat(event.messages);
    }
    if (event.title !== undefined) session.title = event.title;
    session.updatedAt = event.at;
  }
  return session;
}

function readTranscriptFile(file: string): SessionRecord | null {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_TRANSCRIPT_BYTES) return null;
    return projectTranscript(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function appendEvent(file: string, event: SessionEvent): boolean {
  try {
    ensureDir();
    const line = `${JSON.stringify(event)}\n`;
    if (Buffer.byteLength(line, 'utf8') > MAX_EVENT_BYTES) return false;
    fs.appendFileSync(file, line, { encoding: 'utf8', mode: 0o600, flag: 'a' });
    return true;
  } catch {
    return false;
  }
}

function writeNewTranscript(session: SessionRecord): boolean {
  try {
    ensureDir();
    const created: SessionCreatedEvent = {
      version: 1,
      type: 'session.created',
      at: session.createdAt,
      session: {
        id: session.id,
        workspace: session.workspace,
        workspaceKey: session.workspaceKey,
        title: session.title,
        createdAt: session.createdAt
      }
    };
    let text = `${JSON.stringify(created)}\n`;
    if (session.messages.length > 0) {
      const restored: MessagesReplacedEvent = {
        version: 1,
        type: 'messages.replaced',
        at: session.updatedAt,
        messages: session.messages,
        title: session.title
      };
      text += `${JSON.stringify(restored)}\n`;
    }
    fs.writeFileSync(sessionTranscriptFile(session.id), text, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

function migrateLegacySession(id: string): SessionRecord | null {
  const file = legacySessionFile(id);
  try {
    if (!fs.existsSync(file)) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!isObject(parsed)
      || parsed.id !== id
      || typeof parsed.workspace !== 'string'
      || typeof parsed.title !== 'string'
      || typeof parsed.createdAt !== 'number'
      || typeof parsed.updatedAt !== 'number'
      || !validMessages(parsed.messages)) return null;
    const session: SessionRecord = {
      id,
      workspace: parsed.workspace,
      workspaceKey: typeof parsed.workspaceKey === 'string' ? parsed.workspaceKey : workspaceKey(parsed.workspace),
      title: parsed.title,
      createdAt: parsed.createdAt,
      updatedAt: parsed.updatedAt,
      messages: parsed.messages
    };
    if (!writeNewTranscript(session)) return null;
    fs.renameSync(file, `${file}.migrated`);
    return session;
  } catch {
    return null;
  }
}

function readSession(id: unknown): SessionRecord | null {
  const safe = safeSessionId(id);
  if (!safe) return null;
  const journal = sessionTranscriptFile(safe);
  if (fs.existsSync(journal)) return readTranscriptFile(journal);
  return migrateLegacySession(safe);
}

export function titleFrom(text: unknown): string {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!clean) return 'Untitled';
  return clean.length > 60 ? `${clean.slice(0, 57)}…` : clean;
}

export function listSessions(): Array<Omit<SessionRecord, 'messages'> & { messageCount: number }> {
  try {
    ensureDir();
    const ids = new Set<string>();
    for (const name of fs.readdirSync(SESSION_DIR)) {
      const match = name.match(/^(s_[a-zA-Z0-9_-]+)\.(?:jsonl|json)$/);
      if (match?.[1]) ids.add(match[1]);
    }
    const rows: Array<Omit<SessionRecord, 'messages'> & { messageCount: number }> = [];
    for (const id of ids) {
      const session = readSession(id);
      if (!session) continue;
      const { messages, ...metadata } = session;
      rows.push({ ...metadata, messageCount: messages.length });
    }
    return rows.sort((left, right) => right.updatedAt - left.updatedAt);
  } catch {
    return [];
  }
}

export function pruneSessions(max = MAX_SESSIONS): number {
  let removed = 0;
  for (const row of listSessions().slice(max)) {
    let removedSession = false;
    for (const file of [sessionTranscriptFile(row.id), legacySessionFile(row.id), `${legacySessionFile(row.id)}.migrated`]) {
      try {
        fs.unlinkSync(file);
        removedSession = true;
      } catch { /* absent files need no action */ }
    }
    if (removedSession) removed += 1;
  }
  return removed;
}

export function createSession(workspace: unknown, title = 'Untitled', makeActive = true): SessionRecord {
  const now = Date.now();
  const workspaceText = String(workspace ?? '');
  const session: SessionRecord = {
    id: `s_${now.toString(36)}_${crypto.randomBytes(3).toString('hex')}`,
    workspace: workspaceText,
    workspaceKey: workspaceKey(workspaceText),
    title,
    createdAt: now,
    updatedAt: now,
    messages: []
  };
  // Persistence is best-effort. An unavailable state directory must not stop a
  // user from starting an otherwise usable foreground session.
  writeNewTranscript(session);
  if (makeActive) setActiveSession(session.id);
  pruneSessions();
  return session;
}

/**
 * Read one conversation without making it the active session.
 *
 * Server-owned conversations must never move the terminal's active pointer;
 * they only need the transcript that belongs to their own id.
 */
export function getSession(id: unknown): SessionRecord | null {
  return readSession(id);
}

export function getActiveSessionId(): string | null {
  try {
    if (!fs.existsSync(POINTER_FILE)) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(POINTER_FILE, 'utf8'));
    return isObject(parsed) && typeof parsed.id === 'string' && parsed.id ? parsed.id : null;
  } catch {
    return null;
  }
}

export function setActiveSession(id: unknown): boolean {
  try {
    ensureDir();
    const safe = safeSessionId(id);
    fs.writeFileSync(POINTER_FILE, `${JSON.stringify({ id: safe || null, at: Date.now() }, null, 2)}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

export function resolveSession(workspace: unknown): SessionRecord {
  const workspaceText = String(workspace ?? '');
  ensureDir();
  migrateLegacyHistory(workspaceText);
  const key = workspaceKey(workspaceText);
  const now = Date.now();
  const candidate = listSessions()
    .filter((row) => row.workspace && row.workspaceKey === key)
    .find((row) => now - row.updatedAt < RESUME_WINDOW_MS);
  if (candidate) {
    const session = readSession(candidate.id);
    if (session) {
      setActiveSession(session.id);
      return session;
    }
  }
  return createSession(workspaceText);
}

export function switchSession(id: unknown): SessionRecord | null {
  const session = readSession(id);
  if (!session) return null;
  setActiveSession(session.id);
  return session;
}

function messageEqual(left: SessionMessage, right: SessionMessage): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function suffixPrefixOverlap(previous: SessionMessage[], next: SessionMessage[]): number {
  const ceiling = Math.min(previous.length, next.length);
  for (let size = ceiling; size > 0; size -= 1) {
    const offset = previous.length - size;
    let matches = true;
    for (let index = 0; index < size; index += 1) {
      const left = previous[offset + index];
      const right = next[index];
      if (left === undefined || right === undefined || !messageEqual(left, right)) {
        matches = false;
        break;
      }
    }
    if (matches) return size;
  }
  return 0;
}

export function saveSessionMessages(id: unknown, messages: unknown): boolean {
  const session = readSession(id);
  if (!session || !validMessages(messages)) return false;
  const nextMessages = messages.slice();
  const firstUser = nextMessages.find((message) => message.role === 'user' && typeof message.content === 'string');
  const nextTitle = (!session.title || session.title === 'Untitled') && firstUser
    ? titleFrom(firstUser.content)
    : session.title;
  const prefix = session.messages.length <= nextMessages.length
    && session.messages.every((message, index) => {
      const next = nextMessages[index];
      return next !== undefined && messageEqual(message, next);
    });
  const changedTitle = nextTitle !== session.title;
  if (prefix && session.messages.length === nextMessages.length && !changedTitle) return true;
  let event: SessionEvent;
  if (prefix) {
    event = {
      version: 1,
      type: 'messages.appended',
      at: Date.now(),
      messages: nextMessages.slice(session.messages.length),
      ...(changedTitle ? { title: nextTitle } : {})
    };
  } else {
    const overlap = suffixPrefixOverlap(session.messages, nextMessages);
    event = overlap > 0 || nextMessages.length === 0
      ? {
          version: 1,
          type: 'messages.windowed',
          at: Date.now(),
          dropPrefix: session.messages.length - overlap,
          messages: nextMessages.slice(overlap),
          ...(changedTitle ? { title: nextTitle } : {})
        }
      : {
          version: 1,
          type: 'messages.replaced',
          at: Date.now(),
          messages: nextMessages,
          ...(changedTitle ? { title: nextTitle } : {})
        };
  }
  return appendEvent(sessionTranscriptFile(session.id), event);
}

export function restoreSessionFromSnapshot(file: string, snapshot: Buffer): boolean {
  try {
    const resolved = path.resolve(file);
    const root = path.resolve(SESSION_DIR);
    if (path.dirname(resolved) !== root || path.extname(resolved) !== '.jsonl') return false;
    const restored = projectTranscript(snapshot.toString('utf8'));
    if (!restored || sessionTranscriptFile(restored.id) !== resolved) return false;
    if (!fs.existsSync(resolved)) {
      fs.writeFileSync(resolved, snapshot, { mode: 0o600, flag: 'wx' });
      return true;
    }
    return appendEvent(resolved, {
      version: 1,
      type: 'messages.replaced',
      at: Date.now(),
      messages: restored.messages,
      title: restored.title
    });
  } catch {
    return false;
  }
}

export function deleteSession(id: unknown): boolean {
  const safe = safeSessionId(id);
  if (!safe) return false;
  let removed = false;
  for (const file of [sessionTranscriptFile(safe), legacySessionFile(safe), `${legacySessionFile(safe)}.migrated`]) {
    try {
      fs.unlinkSync(file);
      removed = true;
    } catch { /* absent files need no action */ }
  }
  if (removed && getActiveSessionId() === safe) setActiveSession(null);
  return removed;
}

export function migrateLegacyHistory(workspace: string): SessionRecord | null {
  try {
    if (!fs.existsSync(LEGACY_HISTORY)) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(LEGACY_HISTORY, 'utf8'));
    if (!validMessages(parsed) || parsed.length === 0) {
      fs.renameSync(LEGACY_HISTORY, `${LEGACY_HISTORY}.migrated`);
      return null;
    }
    const firstUser = parsed.find((message) => message.role === 'user' && typeof message.content === 'string');
    const session = createSession(workspace, titleFrom(firstUser?.content ?? 'Imported conversation'));
    const imported: SessionRecord = {
      ...session,
      workspace: '',
      workspaceKey: '',
      title: session.title === 'Untitled' ? 'Imported conversation' : `${session.title} (imported)`,
      createdAt: fs.statSync(LEGACY_HISTORY).mtimeMs,
      updatedAt: Date.now(),
      messages: parsed.filter((message) => message.role !== 'system')
    };
    fs.unlinkSync(sessionTranscriptFile(session.id));
    if (!writeNewTranscript(imported)) return null;
    fs.renameSync(LEGACY_HISTORY, `${LEGACY_HISTORY}.migrated`);
    return imported;
  } catch {
    return null;
  }
}
