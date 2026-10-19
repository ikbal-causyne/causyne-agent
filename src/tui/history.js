// Persisted prompt history.
//
// Every serious terminal tool remembers what you typed. The chat did not: close
// it and the last hour of prompts was gone.
//
// SECURITY: a shell history file is a classic place for a key to leak, and this
// one is written by a program whose users paste API keys into it. Any line that
// redactSecrets() would alter is a line that contains something credential
// shaped, and it is never written to disk. Losing one recallable prompt is
// cheaper than persisting a key in plaintext.
//
// Pure Node. No dependency, no shell.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { redactSecrets } from './text.js';
import { causyneHome } from '../utils/paths.js';

export const MAX_ENTRIES = 500;

function historyPath() {
  return path.join(causyneHome(), 'history');
}

/** True when the line carries something that looks like a credential. */
export function looksSensitive(line) {
  return redactSecrets(line) !== line;
}

export class PromptHistory {
  constructor(options = {}) {
    this.file = options.file || historyPath();
    this.entries = [];
    this.cursor = -1;      // -1 means "editing a fresh line, not browsing"
    this.draft = '';
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      this.entries = raw.split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          try {
            const parsed = JSON.parse(line);
            return typeof parsed === 'string' ? parsed : null;
          } catch (e) {
            return null;
          }
        })
        .filter((entry) => typeof entry === 'string' && entry.length > 0);
    } catch (e) {
      this.entries = []; // no history yet is the normal first run
    }
    if (this.entries.length > MAX_ENTRIES) {
      this.entries = this.entries.slice(-MAX_ENTRIES);
    }
    this.cursor = -1;
  }

  /**
   * Record a submitted prompt.
   *
   * Returns false when the line was deliberately not kept, so a caller can say
   * so rather than leaving the user to wonder why it never comes back.
   */
  add(text) {
    const line = String(text == null ? '' : text).trim();
    this.cursor = -1;
    this.draft = '';

    if (!line) return false;
    if (looksSensitive(line)) return false;
    // Consecutive duplicates are noise; re-running the same prompt is common.
    if (this.entries[this.entries.length - 1] === line) return true;

    this.entries.push(line);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries = this.entries.slice(-MAX_ENTRIES);
    }
    this.persist();
    return true;
  }

  persist() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const body = this.entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
      // Write then rename: a crash mid-write must not truncate the history.
      const temporary = this.file + '.tmp';
      fs.writeFileSync(temporary, body, { mode: 0o600 });
      fs.renameSync(temporary, this.file);
    } catch (e) {
      // History is a convenience. Failing to save it must never break the chat.
    }
  }

  /**
   * Entries matching the prefix the user has already typed, newest first.
   *
   * Typing `npm ` then pressing Up should walk npm prompts, not everything.
   */
  matching(prefix) {
    if (!prefix) return this.entries.slice().reverse();
    return this.entries.filter((entry) => entry.startsWith(prefix)).reverse();
  }

  /** Older entry, or null at the end. `draft` is the line being edited. */
  previous(draft) {
    if (this.cursor === -1) this.draft = draft;
    const pool = this.matching(this.draft);
    if (pool.length === 0) return null;
    const next = Math.min(this.cursor + 1, pool.length - 1);
    if (next === this.cursor) return null;
    this.cursor = next;
    return pool[this.cursor];
  }

  /** Newer entry, or the original draft once the walk returns to the start. */
  next() {
    if (this.cursor <= -1) return null;
    const pool = this.matching(this.draft);
    this.cursor -= 1;
    if (this.cursor === -1) return this.draft;
    return pool[this.cursor] ?? this.draft;
  }

  reset() {
    this.cursor = -1;
    this.draft = '';
  }
}
