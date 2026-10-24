import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { causyneHome } from './utils/paths.js';
export const SESSION_DIR = path.join(causyneHome(), 'sessions');
const LEGACY_HISTORY = path.join(causyneHome(), 'memory', 'chat_history.json');
const POINTER_FILE = path.join(SESSION_DIR, 'active.json');
export const RESUME_WINDOW_MS = 12 * 60 * 60 * 1000;
export const MAX_SESSIONS = 50;
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const MAX_EVENT_BYTES = 8 * 1024 * 1024;
function ensureDir() {
    if (!fs.existsSync(SESSION_DIR))
        fs.mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
}
function safeSessionId(id) {
    return String(id ?? '').replace(/[^a-zA-Z0-9_-]/g, '');
}
function workspaceKey(workspace) {
    return crypto.createHash('sha256').update(String(workspace ?? '')).digest('hex').slice(0, 12);
}
export function sessionTranscriptFile(id) {
    return path.join(SESSION_DIR, `${safeSessionId(id)}.jsonl`);
}
function legacySessionFile(id) {
    return path.join(SESSION_DIR, `${safeSessionId(id)}.json`);
}
function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function validMessage(value) {
    return isObject(value) && typeof value.role === 'string' && value.role.length > 0;
}
function validMessages(value) {
    return Array.isArray(value) && value.every(validMessage);
}
function parseEvent(value) {
    if (!isObject(value) || value.version !== 1 || typeof value.type !== 'string' || typeof value.at !== 'number')
        return null;
    if (value.type === 'session.created') {
        const session = value.session;
        if (!isObject(session)
            || typeof session.id !== 'string'
            || typeof session.workspace !== 'string'
            || typeof session.workspaceKey !== 'string'
            || typeof session.title !== 'string'
            || typeof session.createdAt !== 'number')
            return null;
        return value;
    }
    if (value.type === 'messages.appended') {
        if (!validMessages(value.messages))
            return null;
        if (value.title !== undefined && typeof value.title !== 'string')
            return null;
        return value;
    }
    if (value.type === 'messages.replaced') {
        if (!validMessages(value.messages))
            return null;
        if (value.title !== undefined && typeof value.title !== 'string')
            return null;
        return value;
    }
    if (value.type === 'messages.windowed') {
        if (!Number.isInteger(value.dropPrefix) || Number(value.dropPrefix) < 0 || !validMessages(value.messages))
            return null;
        if (value.title !== undefined && typeof value.title !== 'string')
            return null;
        return value;
    }
    return null;
}
function projectTranscript(text) {
    const trailingNewline = text.endsWith('\n');
    const lines = text.split('\n');
    if (lines.at(-1) === '')
        lines.pop();
    let session = null;
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (line === undefined || line.trim() === '')
            continue;
        if (Buffer.byteLength(line, 'utf8') > MAX_EVENT_BYTES)
            return null;
        let raw;
        try {
            raw = JSON.parse(line);
        }
        catch {
            // O_APPEND can still be interrupted between bytes. Retain complete events
            // before a torn final line; never guess around corruption in the middle.
            if (index === lines.length - 1 && !trailingNewline)
                break;
            return null;
        }
        const event = parseEvent(raw);
        if (!event)
            return null;
        if (event.type === 'session.created') {
            if (session)
                return null;
            session = { ...event.session, updatedAt: event.at, messages: [] };
            continue;
        }
        if (!session)
            return null;
        if (event.type === 'messages.appended')
            session.messages.push(...event.messages);
        else if (event.type === 'messages.replaced')
            session.messages = event.messages.slice();
        else {
            if (event.dropPrefix > session.messages.length)
                return null;
            session.messages = session.messages.slice(event.dropPrefix).concat(event.messages);
        }
        if (event.title !== undefined)
            session.title = event.title;
        session.updatedAt = event.at;
    }
    return session;
}
function readTranscriptFile(file) {
    try {
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.size > MAX_TRANSCRIPT_BYTES)
            return null;
        return projectTranscript(fs.readFileSync(file, 'utf8'));
    }
    catch {
        return null;
    }
}
function appendEvent(file, event) {
    try {
        ensureDir();
        const line = `${JSON.stringify(event)}\n`;
        if (Buffer.byteLength(line, 'utf8') > MAX_EVENT_BYTES)
            return false;
        fs.appendFileSync(file, line, { encoding: 'utf8', mode: 0o600, flag: 'a' });
        return true;
    }
    catch {
        return false;
    }
}
function writeNewTranscript(session) {
    try {
        ensureDir();
        const created = {
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
            const restored = {
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
    }
    catch {
        return false;
    }
}
function migrateLegacySession(id) {
    const file = legacySessionFile(id);
    try {
        if (!fs.existsSync(file))
            return null;
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!isObject(parsed)
            || parsed.id !== id
            || typeof parsed.workspace !== 'string'
            || typeof parsed.title !== 'string'
            || typeof parsed.createdAt !== 'number'
            || typeof parsed.updatedAt !== 'number'
            || !validMessages(parsed.messages))
            return null;
        const session = {
            id,
            workspace: parsed.workspace,
            workspaceKey: typeof parsed.workspaceKey === 'string' ? parsed.workspaceKey : workspaceKey(parsed.workspace),
            title: parsed.title,
            createdAt: parsed.createdAt,
            updatedAt: parsed.updatedAt,
            messages: parsed.messages
        };
        if (!writeNewTranscript(session))
            return null;
        fs.renameSync(file, `${file}.migrated`);
        return session;
    }
    catch {
        return null;
    }
}
function readSession(id) {
    const safe = safeSessionId(id);
    if (!safe)
        return null;
    const journal = sessionTranscriptFile(safe);
    if (fs.existsSync(journal))
        return readTranscriptFile(journal);
    return migrateLegacySession(safe);
}
export function titleFrom(text) {
    const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!clean)
        return 'Untitled';
    return clean.length > 60 ? `${clean.slice(0, 57)}…` : clean;
}
export function listSessions() {
    try {
        ensureDir();
        const ids = new Set();
        for (const name of fs.readdirSync(SESSION_DIR)) {
            const match = name.match(/^(s_[a-zA-Z0-9_-]+)\.(?:jsonl|json)$/);
            if (match?.[1])
                ids.add(match[1]);
        }
        const rows = [];
        for (const id of ids) {
            const session = readSession(id);
            if (!session)
                continue;
            const { messages, ...metadata } = session;
            rows.push({ ...metadata, messageCount: messages.length });
        }
        return rows.sort((left, right) => right.updatedAt - left.updatedAt);
    }
    catch {
        return [];
    }
}
export function pruneSessions(max = MAX_SESSIONS) {
    let removed = 0;
    for (const row of listSessions().slice(max)) {
        let removedSession = false;
        for (const file of [sessionTranscriptFile(row.id), legacySessionFile(row.id), `${legacySessionFile(row.id)}.migrated`]) {
            try {
                fs.unlinkSync(file);
                removedSession = true;
            }
            catch { /* absent files need no action */ }
        }
        if (removedSession)
            removed += 1;
    }
    return removed;
}
export function createSession(workspace, title = 'Untitled', makeActive = true) {
    const now = Date.now();
    const workspaceText = String(workspace ?? '');
    const session = {
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
    if (makeActive)
        setActiveSession(session.id);
    pruneSessions();
    return session;
}
/**
 * Read one conversation without making it the active session.
 *
 * Server-owned conversations must never move the terminal's active pointer;
 * they only need the transcript that belongs to their own id.
 */
export function getSession(id) {
    return readSession(id);
}
export function getActiveSessionId() {
    try {
        if (!fs.existsSync(POINTER_FILE))
            return null;
        const parsed = JSON.parse(fs.readFileSync(POINTER_FILE, 'utf8'));
        return isObject(parsed) && typeof parsed.id === 'string' && parsed.id ? parsed.id : null;
    }
    catch {
        return null;
    }
}
export function setActiveSession(id) {
    try {
        ensureDir();
        const safe = safeSessionId(id);
        fs.writeFileSync(POINTER_FILE, `${JSON.stringify({ id: safe || null, at: Date.now() }, null, 2)}\n`, { mode: 0o600 });
        return true;
    }
    catch {
        return false;
    }
}
export function resolveSession(workspace, options = {}) {
    const workspaceText = String(workspace ?? '');
    ensureDir();
    migrateLegacyHistory(workspaceText);
    if (options.forceNew) {
        return createSession(workspaceText);
    }
    const key = workspaceKey(workspaceText);
    const now = Date.now();
    // 1. Check preferred session or active.json pointer for this workspace
    const targetId = options.preferredId || getActiveSessionId();
    if (targetId) {
        const active = readSession(targetId);
        if (active && (!active.workspace || active.workspaceKey === key) && now - active.updatedAt < RESUME_WINDOW_MS) {
            setActiveSession(active.id);
            return active;
        }
    }
    // 2. Resume most recent workspace conversation within resume window
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
export function switchSession(id) {
    const session = readSession(id);
    if (!session)
        return null;
    setActiveSession(session.id);
    return session;
}
/**
 * Fork an existing session into a new conversation in the same workspace.
 *
 * CRITICAL TRUST & PERMISSION INVARIANT (Claude Code Architecture, p. 24):
 * Forking copies conversation history up to the designated turn, creating a
 * distinct trajectory. Permissions, standing approvals, and tool allowlists
 * are strictly bound to the originating session lifecycle and must NEVER be
 * inherited into a fork. The forked session starts with fresh, ungranted
 * permissions so that user authorization and trust are freshly established.
 */
export function forkSession(sourceId, options = {}) {
    const source = readSession(sourceId);
    if (!source)
        return null;
    const targetWorkspace = options.workspace || source.workspace || process.cwd();
    const sourceTitle = source.title && source.title !== 'Untitled' ? source.title : 'Conversation';
    const newTitle = options.title || `Fork of ${sourceTitle}`;
    const newSession = createSession(targetWorkspace, newTitle, options.makeActive ?? true);
    let messagesToCopy = Array.isArray(source.messages) ? source.messages : [];
    if (typeof options.upToMessageIndex === 'number' && options.upToMessageIndex >= 0) {
        messagesToCopy = messagesToCopy.slice(0, options.upToMessageIndex + 1);
    }
    if (messagesToCopy.length > 0) {
        const clonedMessages = JSON.parse(JSON.stringify(messagesToCopy));
        saveSessionMessages(newSession.id, clonedMessages);
    }
    return readSession(newSession.id);
}
function messageEqual(left, right) {
    return JSON.stringify(left) === JSON.stringify(right);
}
function suffixPrefixOverlap(previous, next) {
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
        if (matches)
            return size;
    }
    return 0;
}
export function saveSessionMessages(id, messages) {
    const session = readSession(id);
    if (!session || !validMessages(messages))
        return false;
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
    if (prefix && session.messages.length === nextMessages.length && !changedTitle)
        return true;
    let event;
    if (prefix) {
        event = {
            version: 1,
            type: 'messages.appended',
            at: Date.now(),
            messages: nextMessages.slice(session.messages.length),
            ...(changedTitle ? { title: nextTitle } : {})
        };
    }
    else {
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
export function restoreSessionFromSnapshot(file, snapshot) {
    try {
        const resolved = path.resolve(file);
        const root = path.resolve(SESSION_DIR);
        if (path.dirname(resolved) !== root || path.extname(resolved) !== '.jsonl')
            return false;
        const restored = projectTranscript(snapshot.toString('utf8'));
        if (!restored || sessionTranscriptFile(restored.id) !== resolved)
            return false;
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
    }
    catch {
        return false;
    }
}
export function deleteSession(id) {
    const safe = safeSessionId(id);
    if (!safe)
        return false;
    let removed = false;
    for (const file of [sessionTranscriptFile(safe), legacySessionFile(safe), `${legacySessionFile(safe)}.migrated`]) {
        try {
            fs.unlinkSync(file);
            removed = true;
        }
        catch { /* absent files need no action */ }
    }
    if (removed && getActiveSessionId() === safe)
        setActiveSession(null);
    return removed;
}
export function migrateLegacyHistory(workspace) {
    try {
        if (!fs.existsSync(LEGACY_HISTORY))
            return null;
        const parsed = JSON.parse(fs.readFileSync(LEGACY_HISTORY, 'utf8'));
        if (!validMessages(parsed) || parsed.length === 0) {
            fs.renameSync(LEGACY_HISTORY, `${LEGACY_HISTORY}.migrated`);
            return null;
        }
        const firstUser = parsed.find((message) => message.role === 'user' && typeof message.content === 'string');
        const session = createSession(workspace, titleFrom(firstUser?.content ?? 'Imported conversation'));
        const imported = {
            ...session,
            workspace: '',
            workspaceKey: '',
            title: session.title === 'Untitled' ? 'Imported conversation' : `${session.title} (imported)`,
            createdAt: fs.statSync(LEGACY_HISTORY).mtimeMs,
            updatedAt: Date.now(),
            messages: parsed.filter((message) => message.role !== 'system')
        };
        fs.unlinkSync(sessionTranscriptFile(session.id));
        if (!writeNewTranscript(imported))
            return null;
        fs.renameSync(LEGACY_HISTORY, `${LEGACY_HISTORY}.migrated`);
        return imported;
    }
    catch {
        return null;
    }
}
