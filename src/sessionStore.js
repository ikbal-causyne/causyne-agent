import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { causyneHome } from './utils/paths.js';

// Chat sessions. One conversation, one file, scoped to one workspace.
//
// WHAT THIS REPLACES, AND WHY IT HAD TO GO.
//
// There was exactly one `~/.causyne/memory/chat_history.json`. No id, no
// workspace key, no time bound. Every invocation of Causyne, in every directory,
// on every project, loaded the SAME conversation. So:
//
//   work on Causyne in ~/Causyne        -> history saved
//   weeks later, open ~/Desktop/3d    -> the SAME history loads
//   type "continue"                   -> the agent resumes the Causyne
//                                        conversation, in the Blender directory,
//                                        and goes scanning the old project
//
// That is not a memory feature working. It is one unbounded conversation
// impersonating a memory, and it gets worse every day it is used: context from
// months-old work leaks into today's task, and work from one client's project
// leaks into another's.
//
// THE MODEL, taken from opencode's SessionV2.Info (id, projectID, title,
// time.created/updated/archived): a session belongs to a WORKSPACE and is
// resumed only when it is both the same workspace and recent. A different
// directory is a different conversation. An old conversation in the same
// directory is still there — listed, switchable — but it does not silently
// become the thing "continue" continues.

const SESSION_DIR = path.join(causyneHome(), 'sessions');
const LEGACY_HISTORY = path.join(causyneHome(), 'memory', 'chat_history.json');
const POINTER_FILE = path.join(SESSION_DIR, 'active.json');

/**
 * How long a session stays resumable in its own workspace.
 *
 * Past this, returning to the directory starts a NEW conversation rather than
 * reviving one whose subject you have forgotten. The old one is still listed
 * and can be resumed by name — the point is that it stops being the default.
 */
const RESUME_WINDOW_MS = 12 * 60 * 60 * 1000;

/** Hard ceiling on retained sessions. The oldest are archived out first. */
const MAX_SESSIONS = 50;

function ensureDir() {
  if (!fs.existsSync(SESSION_DIR)) fs.mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
}

/** A stable, filesystem-safe key for a workspace path. */
function workspaceKey(workspace) {
  return crypto.createHash('sha256').update(String(workspace || '')).digest('hex').slice(0, 12);
}

function sessionFile(id) {
  const safe = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(SESSION_DIR, `${safe}.json`);
}

/**
 * A short human title from the first thing the user actually asked for.
 *
 * `chat_history.json` had no title at all, which is why nothing could ever be
 * listed or chosen. A session you cannot name is a session you cannot leave.
 */
export function titleFrom(text) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return 'Untitled';
  return clean.length > 60 ? clean.slice(0, 57) + '…' : clean;
}

function readSession(id) {
  try {
    const file = sessionFile(id);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null; // a corrupt session degrades to "no session", never to a crash
  }
}

function writeSession(session) {
  try {
    ensureDir();
    fs.writeFileSync(sessionFile(session.id), JSON.stringify(session, null, 2), { mode: 0o600 });
    return true;
  } catch (e) {
    return false; // fail open: losing a session must not fail the task
  }
}

/** Every session, newest first. Messages are NOT loaded — this is the index. */
export function listSessions() {
  try {
    ensureDir();
    const rows = [];
    for (const name of fs.readdirSync(SESSION_DIR)) {
      if (!name.endsWith('.json') || name === 'active.json') continue;
      const session = readSession(name.replace(/\.json$/, ''));
      if (!session) continue;
      rows.push({
        id: session.id,
        title: session.title || 'Untitled',
        workspace: session.workspace || '',
        createdAt: session.createdAt || 0,
        updatedAt: session.updatedAt || 0,
        messageCount: Array.isArray(session.messages) ? session.messages.length : 0
      });
    }
    return rows.sort((a, b) => b.updatedAt - a.updatedAt);
  } catch (e) {
    return [];
  }
}

/**
 * Retire the oldest sessions past MAX_SESSIONS.
 *
 * Called at session resolution rather than on a timer — nothing may run in the
 * background (ZM-01), and a session boundary is often enough for a ceiling
 * measured in dozens.
 */
export function pruneSessions(max = MAX_SESSIONS) {
  try {
    const all = listSessions();
    let removed = 0;
    for (const row of all.slice(max)) {
      try { fs.unlinkSync(sessionFile(row.id)); removed++; } catch (e) { /* skip */ }
    }
    return removed;
  } catch (e) {
    return 0;
  }
}

export function createSession(workspace, title = 'Untitled') {
  const now = Date.now();
  const session = {
    id: `s_${now.toString(36)}_${crypto.randomBytes(3).toString('hex')}`,
    workspace: String(workspace || ''),
    workspaceKey: workspaceKey(workspace),
    title,
    createdAt: now,
    updatedAt: now,
    messages: []
  };
  writeSession(session);
  setActiveSession(session.id);
  pruneSessions();
  return session;
}

export function getActiveSessionId() {
  try {
    if (!fs.existsSync(POINTER_FILE)) return null;
    return JSON.parse(fs.readFileSync(POINTER_FILE, 'utf8')).id || null;
  } catch (e) {
    return null;
  }
}

export function setActiveSession(id) {
  try {
    ensureDir();
    fs.writeFileSync(POINTER_FILE, JSON.stringify({ id, at: Date.now() }, null, 2), { mode: 0o600 });
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * The session this workspace should be using right now.
 *
 * THE RULE THAT FIXES THE BOOMERANG: resume only when the workspace matches AND
 * the conversation is recent. Anything else starts fresh. A different directory
 * is a different conversation, full stop.
 *
 * @param   {string} workspace  Usually process.cwd().
 * @returns {object}            The session, with its messages loaded.
 */
export function resolveSession(workspace) {
  ensureDir();
  migrateLegacyHistory(workspace);

  const key = workspaceKey(workspace);
  const now = Date.now();

  const candidate = listSessions()
    .filter(row => row.workspace && workspaceKey(row.workspace) === key)
    .find(row => now - row.updatedAt < RESUME_WINDOW_MS);

  if (candidate) {
    const session = readSession(candidate.id);
    if (session) {
      setActiveSession(session.id);
      return session;
    }
  }

  return createSession(workspace);
}

/** Load a specific session by id, making it active. */
export function switchSession(id) {
  const session = readSession(id);
  if (!session) return null;
  setActiveSession(session.id);
  return session;
}

/** Persist a session's messages. Title is set once, from the first user turn. */
export function saveSessionMessages(id, messages) {
  const session = readSession(id);
  if (!session) return false;

  session.messages = Array.isArray(messages) ? messages : [];
  session.updatedAt = Date.now();

  if (!session.title || session.title === 'Untitled') {
    const firstUser = session.messages.find(m => m.role === 'user' && typeof m.content === 'string');
    if (firstUser) session.title = titleFrom(firstUser.content);
  }

  return writeSession(session);
}

export function deleteSession(id) {
  try {
    fs.unlinkSync(sessionFile(id));
    if (getActiveSessionId() === id) setActiveSession(null);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Move the one global history into a session, once.
 *
 * Nothing is thrown away — the conversation that existed becomes a session
 * belonging to the workspace it is first seen from, and the legacy file is
 * renamed rather than deleted so it can be recovered if the migration is wrong.
 */
export function migrateLegacyHistory(workspace) {
  try {
    if (!fs.existsSync(LEGACY_HISTORY)) return null;

    const raw = fs.readFileSync(LEGACY_HISTORY, 'utf8');
    const messages = JSON.parse(raw);
    if (!Array.isArray(messages) || messages.length === 0) {
      fs.renameSync(LEGACY_HISTORY, LEGACY_HISTORY + '.migrated');
      return null;
    }

    const firstUser = messages.find(m => m.role === 'user' && typeof m.content === 'string');
    const session = createSession(workspace, titleFrom(firstUser ? firstUser.content : 'Imported conversation'));
    session.messages = messages.filter(m => m.role !== 'system');
    session.createdAt = fs.statSync(LEGACY_HISTORY).mtimeMs;
    // NO WORKSPACE, deliberately. The legacy file belonged to every directory
    // at once, so attaching it to whichever one happens to migrate it first
    // would just recreate the boomerang somewhere arbitrary. It stays listed
    // and switchable by name; it is never what `continue` continues.
    session.workspace = '';
    session.workspaceKey = '';
    session.title = session.title === 'Untitled' ? 'Imported conversation' : session.title + ' (imported)';
    writeSession(session);

    fs.renameSync(LEGACY_HISTORY, LEGACY_HISTORY + '.migrated');
    return session;
  } catch (e) {
    return null;
  }
}

export { SESSION_DIR, RESUME_WINDOW_MS, MAX_SESSIONS };
