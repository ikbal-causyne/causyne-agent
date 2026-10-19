import fs from 'fs';
import path from 'path';
import { resolveSession, createSession, switchSession, saveSessionMessages } from './sessionStore.js';
import os from 'os';
import { causyneHome } from './utils/paths.js';

const MEMORY_DIR = path.join(causyneHome(), 'memory');
const CHAT_HISTORY_FILE = path.join(MEMORY_DIR, 'chat_history.json');

// Persistence ceilings. Without them chat_history.json grew for the lifetime of
// the installation: every new task reloaded a file that could be tens of
// megabytes, and the sliding window filled to its limit before the user had
// typed a single word — so even "list my files" paid a full context window.
const MAX_PERSISTED_MESSAGES = 120;
const MAX_PERSISTED_CHARS = 400000;
const MAX_SINGLE_MESSAGE_CHARS = 40000;

function contentLength(content) {
  if (typeof content === 'string') return content.length;
  if (content == null) return 0;
  return JSON.stringify(content).length;
}

export class MemoryManager {
  /**
   * @param {string} workspace  The directory this conversation belongs to.
   *
   * History is now per SESSION, and a session belongs to a workspace. It used
   * to be one global chat_history.json read by every invocation in every
   * directory — so typing continue in a new project resumed a conversation
   * from a different one, months old. See src/sessionStore.js.
   */
  constructor(workspace = process.cwd()) {
    this.ensureMemoryDir();
    this.workspace = workspace;
    this.session = resolveSession(workspace);
  }

  /** The active session's id, for the status line and /sessions. */
  get sessionId() { return this.session ? this.session.id : null; }
  get sessionTitle() { return this.session ? this.session.title : ''; }

  /** Abandon this conversation and open a clean one in the same workspace. */
  startNewSession() {
    this.session = createSession(this.workspace);
    return this.session;
  }

  /** Resume a specific past conversation. */
  useSession(id) {
    const next = switchSession(id);
    if (next) this.session = next;
    return next;
  }

  ensureMemoryDir() {
    if (!fs.existsSync(MEMORY_DIR)) {
      fs.mkdirSync(MEMORY_DIR, { recursive: true, mode: 0o700 });
    }
  }

  loadHistory() {
    if (!this.session || !Array.isArray(this.session.messages)) return [];
    // Only return non-system messages to prevent stale system prompts.
    return this.session.messages.filter(m => m.role !== 'system');
  }

  
  boundHistory(messages) {
    const persistable = messages.filter(m => m.role !== 'system');
    const bounded = [];
    let totalChars = 0;

    for (let i = persistable.length - 1; i >= 0; i--) {
      if (bounded.length >= MAX_PERSISTED_MESSAGES) break;

      const msg = persistable[i];
      let content = msg.content;

      if (Array.isArray(content)) {
        const hasMedia = content.some(
          block => block && (block.type === 'image' || block.type === 'image_url' || block.type === 'input_audio')
        );
        if (hasMedia) {
          const captions = content
            .filter(block => block && block.type === 'text' && block.text)
            .map(block => block.text)
            .join(' ');
          content = `[media attachment not persisted] ${captions}`.trim();
        }
      }

      if (typeof content === 'string' && content.length > MAX_SINGLE_MESSAGE_CHARS) {
        content = content.slice(0, MAX_SINGLE_MESSAGE_CHARS) + '\n[... truncated on save ...]';
      }

      const length = contentLength(content);
      if (totalChars + length > MAX_PERSISTED_CHARS && bounded.length > 0) break;
      totalChars += length;

      bounded.unshift(content === msg.content ? msg : { ...msg, content });
    }

    // A history that opens on tool results is unusable: the assistant message
    // that called them was trimmed away.
    while (bounded.length > 0 && bounded[0].role === 'tool') {
      bounded.shift();
    }

    return bounded;
  }

  saveHistory(messages) {
    if (!this.session) return;
    saveSessionMessages(this.session.id, this.boundHistory(messages));
  }

  /** /clear — empties THIS conversation, and leaves every other one alone. */
  clearHistory() {
    if (!this.session) return;
    this.session.messages = [];
    saveSessionMessages(this.session.id, []);
  }
}
