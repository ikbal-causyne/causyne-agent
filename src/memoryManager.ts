import fs from 'node:fs';
import path from 'node:path';
import {
  resolveSession,
  createSession,
  getSession,
  switchSession,
  saveSessionMessages,
  forkSession,
  type SessionRecord,
  type ResolveSessionOptions
} from './sessionStore.js';
import { causyneHome } from './utils/paths.js';

function memoryDir(): string {
  return path.join(causyneHome(), 'memory');
}

const MAX_PERSISTED_MESSAGES = 120;
const MAX_PERSISTED_CHARS = 400000;
const MAX_SINGLE_MESSAGE_CHARS = 40000;

function contentLength(content: unknown): number {
  if (typeof content === 'string') return content.length;
  if (content == null) return 0;
  try {
    const serialized = JSON.stringify(content);
    return typeof serialized === 'string' ? serialized.length : 0;
  } catch {
    return String(content).length;
  }
}

export class MemoryManager {
  workspace: string;
  session: SessionRecord | null;

  constructor(workspace: string = process.cwd(), sessionId: string | null = null, options: ResolveSessionOptions = {}) {
    this.ensureMemoryDir();
    this.workspace = workspace;
    if (sessionId) {
      this.session = getSession(sessionId) || createSession(workspace, 'Untitled', false);
    } else {
      this.session = resolveSession(workspace, options);
    }
  }

  get sessionId(): string | null { return this.session ? this.session.id : null; }
  get sessionTitle(): string { return this.session ? this.session.title : ''; }

  startNewSession(title = 'Untitled'): SessionRecord {
    this.session = createSession(this.workspace, title, true);
    return this.session;
  }

  useSession(id: string): SessionRecord | null {
    const next = switchSession(id);
    if (next) this.session = next;
    return next;
  }

  forkSession(title: string | null = null, upToMessageIndex: number | null = null): SessionRecord | null {
    if (!this.session) return null;
    const forkOpts: { title?: string; upToMessageIndex?: number; makeActive: boolean } = { makeActive: true };
    if (title) forkOpts.title = title;
    if (typeof upToMessageIndex === 'number') forkOpts.upToMessageIndex = upToMessageIndex;
    const forked = forkSession(this.session.id, forkOpts);
    if (forked) {
      this.session = forked;
    }
    return forked;
  }

  ensureMemoryDir(): void {
    const dir = memoryDir();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }

  loadHistory(): Record<string, any>[] {
    if (!this.session || !Array.isArray(this.session.messages)) return [];
    return this.session.messages.filter((m: any) => {
      if (!m || typeof m !== 'object') return false;
      if (m.role !== 'system') return true;
      if (typeof m.content === 'string' && m.content.startsWith('[Continuum')) return true;
      return false;
    });
  }

  boundHistory(messages: readonly any[]): Record<string, any>[] {
    const persistable = messages.filter((m: any) => {
      if (m.role !== 'system') return true;
      if (typeof m.content === 'string' && m.content.startsWith('[Continuum')) return true;
      return false;
    });
    const bounded: Record<string, any>[] = [];
    let totalChars = 0;

    for (let i = persistable.length - 1; i >= 0; i--) {
      if (bounded.length >= MAX_PERSISTED_MESSAGES) break;

      const msg = persistable[i];
      let content = msg.content;

      if (Array.isArray(content)) {
        const hasMedia = content.some(
          (block: any) => block && (block.type === 'image' || block.type === 'image_url' || block.type === 'input_audio')
        );
        if (hasMedia) {
          const captions = content
            .filter((block: any) => block && block.type === 'text' && block.text)
            .map((block: any) => block.text)
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

    while (bounded.length > 0 && bounded[0]?.role === 'tool') {
      bounded.shift();
    }

    return bounded;
  }

  saveHistory(messages: readonly any[]): void {
    if (!this.session) return;
    saveSessionMessages(this.session.id, this.boundHistory(messages));
  }

  clearHistory(): void {
    if (!this.session) return;
    this.session.messages = [];
    saveSessionMessages(this.session.id, []);
  }
}
