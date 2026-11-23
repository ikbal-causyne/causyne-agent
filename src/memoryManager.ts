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

export interface MemoryManagerOptions extends ResolveSessionOptions {
  ephemeral?: boolean | undefined;
}

export class MemoryManager {
  workspace: string;
  session: SessionRecord | null;
  ephemeral: boolean;

  constructor(workspace: string = process.cwd(), sessionId: string | null = null, options: MemoryManagerOptions = {}) {
    const safeWorkspace = typeof workspace === 'string' && workspace.trim() ? workspace : process.cwd();
    const safeOptions = options && typeof options === 'object' ? options : {};
    this.workspace = safeWorkspace;
    this.ephemeral = safeOptions.ephemeral === true;
    if (this.ephemeral) {
      const now = Date.now();
      this.session = {
        id: typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : `ephemeral_${now.toString(36)}`,
        workspace: safeWorkspace,
        workspaceKey: '',
        title: 'Ephemeral session',
        createdAt: now,
        updatedAt: now,
        messages: []
      };
      return;
    }
    this.ensureMemoryDir();
    if (typeof sessionId === 'string' && sessionId.trim()) {
      this.session = getSession(sessionId) || createSession(safeWorkspace, 'Untitled', false);
    } else {
      this.session = resolveSession(safeWorkspace, safeOptions);
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
    try {
      fs.mkdirSync(memoryDir(), { recursive: true, mode: 0o700 });
    } catch {
      // Directory creation failure is handled cleanly by session persistence.
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
    if (!Array.isArray(messages)) return [];
    const persistable = messages.filter((m: any) => {
      if (!m || typeof m !== 'object') return false;
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
            .filter((block: any) => block && block.type === 'text' && typeof block.text === 'string' && block.text.trim())
            .map((block: any) => block.text)
            .join(' ')
            .slice(0, MAX_SINGLE_MESSAGE_CHARS);
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
    const bounded = this.boundHistory(messages);
    if (this.ephemeral) {
      this.session.messages = bounded as any;
      this.session.updatedAt = Date.now();
      return;
    }
    saveSessionMessages(this.session.id, bounded);
  }

  clearHistory(): void {
    if (!this.session) return;
    this.session.messages = [];
    if (this.ephemeral) {
      this.session.updatedAt = Date.now();
      return;
    }
    saveSessionMessages(this.session.id, []);
  }
}
