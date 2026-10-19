import fs from 'fs';
import path from 'path';
import os from 'os';
import { causyneHome } from './utils/paths.js';

// C5 — the resumable embodiment session.
//
// Astra's other headline, next to computer use, is STAYING ON THE JOB. Causyne
// already persists more session state than most agents ship (checkpoints.js,
// the V5 Cortex, the spill store). What none of them carried is the one thing a
// GUI task cannot rebuild from the transcript: WHICH APPLICATION THE AGENT WAS
// DRIVING AND WHAT IT LAST SAW ON SCREEN.
//
// Why that specifically. A file edit is recoverable from disk — the file is

// something into "Notes" only if it re-reads the screen, and re-reading costs a
// full Channel B pass on a window that may since have moved, closed, or been
// replaced. Worse, without the state it does not know whether its last action
// LANDED. Repeating an action that already succeeded is how a GUI agent sends
// the same message twice.
//
// FAIL-OPEN BY CONTRACT. Every function here swallows its own errors and
// returns a safe default. Losing session state must degrade the agent to
// "re-read the screen", never break the task — the same contract outputStore.js
// holds, and for the same reason.
//
// WHAT IS DELIBERATELY NOT STORED: no screenshots, no typed text, no element
// values. A record of what a user's screen said, sitting in a file, is a
// surveillance artefact. Only the app name, the action verbs, and a HASH of the
// last tree are kept — enough to answer "is the screen still as I left it?"
// without keeping the screen.

const SESSION_DIR = path.join(causyneHome(), 'embodiment');

/** Sessions older than this are pruned. A GUI session has no value stale. */
const RETENTION_MS = 24 * 60 * 60 * 1000;

/** Kill switch, matching CAUSYNE_OUTPUT_SPILL's shape. */
export function isSessionTrackingEnabled() {
  return process.env.CAUSYNE_EMBODIMENT_SESSION !== '0';
}

function ensureSessionDir() {
  if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
  }
}


function safeTaskId(taskId) {
  const cleaned = String(taskId || 'default').replace(/[^a-zA-Z0-9_-]/g, '');
  return cleaned === '' ? 'default' : cleaned.slice(0, 64);
}

function sessionFile(taskId) {
  return path.join(SESSION_DIR, `${safeTaskId(taskId)}.json`);
}

/**
 * Cheap, dependency-free digest of a screen reading.
 *
 * Not cryptographic and does not need to be — it answers one question, "is this
 * the same screen I saw before?", where a collision costs one redundant re-read.
 */
function digestOf(text) {
  let hash = 5381;
  const source = String(text || '');
  for (let i = 0; i < source.length; i++) {
    hash = ((hash * 33) ^ source.charCodeAt(i)) >>> 0;
  }
  return `${hash.toString(16)}:${source.length}`;
}

/**
 * Record that the agent observed a screen.
 *
 * @param {string} taskId
 * @param {string} app       Application observed, '' for frontmost.
 * @param {string} treeText  The ax_snapshot output. Hashed, never stored.
 */
export function recordObservation(taskId, app, treeText) {
  if (!isSessionTrackingEnabled()) return;
  try {
    ensureSessionDir();
    const previous = readSession(taskId) || {};
    const state = {
      ...previous,
      app: app || previous.app || '',
      lastTreeDigest: digestOf(treeText),
      lastTreeNodeCount: String(treeText || '').split('\n').filter(Boolean).length,
      observedAt: new Date().toISOString()
    };
    fs.writeFileSync(sessionFile(taskId), JSON.stringify(state, null, 2), { mode: 0o600 });
  } catch (e) {
    // Fail open: a lost session record must never fail the task.
  }
}

/**
 * Record that the agent acted on a screen.
 *
 * Stores the VERBS only, never their arguments. "typed 14 characters into
 * Notes" is enough to resume; the 14 characters are the user's business.
 */
export function recordActuation(taskId, app, verbs) {
  if (!isSessionTrackingEnabled()) return;
  try {
    ensureSessionDir();
    const previous = readSession(taskId) || {};
    const state = {
      ...previous,
      app: app || previous.app || '',
      lastActions: Array.isArray(verbs) ? verbs.map(v => String(v)).slice(0, 12) : [],
      // The screen has almost certainly changed, so the stored digest is stale
      // by definition. Marking it beats silently trusting it.
      lastTreeDigest: null,
      actedAt: new Date().toISOString()
    };
    fs.writeFileSync(sessionFile(taskId), JSON.stringify(state, null, 2), { mode: 0o600 });
  } catch (e) {
    // Fail open.
  }
}

/** @returns {object|null} the stored session, or null when there is none. */
export function readSession(taskId) {
  try {
    const file = sessionFile(taskId);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return null;
  }
}


export function describeSession(taskId) {
  const state = readSession(taskId);
  if (!state || (!state.app && !state.lastActions)) return '';

  const parts = [];
  parts.push(`You were driving ${state.app ? `"${state.app}"` : 'the frontmost application'} before this session resumed.`);
  if (Array.isArray(state.lastActions) && state.lastActions.length > 0) {
    parts.push(`Your last actions were: ${state.lastActions.join(', ')}.`);
    parts.push('You do NOT know whether they landed — the screen may have changed while you were gone.');
  }
  parts.push('Call ax_snapshot before acting again, and compare what you see to what you expected.');
  return `\n\n🖥️ EMBODIMENT SESSION\n${parts.join(' ')}`;
}

/** Drop a task's session, e.g. when the task completes. */
export function clearSession(taskId) {
  try {
    const file = sessionFile(taskId);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  } catch (e) {
    // Fail open.
  }
}

/** Retire sessions past the retention window. Fire-and-forget, never throws. */
export function pruneSessions() {
  try {
    if (!fs.existsSync(SESSION_DIR)) return;
    const cutoff = Date.now() - RETENTION_MS;
    for (const name of fs.readdirSync(SESSION_DIR)) {
      const file = path.join(SESSION_DIR, name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
      } catch (e) { /* skip this one */ }
    }
  } catch (e) {
    // Fail open.
  }
}

/** Where sessions live. For diagnostics and tests. */
export function getSessionDir() {
  return SESSION_DIR;
}
