// Codex Continuum Adapter: reads threads from ~/.codex/thread_history_1.sqlite.
// Authorship: Strict TypeScript (Causyne Agent).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { BaseContinuumAdapter, isSafeIdentifier } from './base.js';
import type { ContinuumSessionSummary, ContinuumSessionDetail, ContinuumMessage } from '../types.js';
import { cleanUserText, cleanAssistantText, deriveSessionTitle } from '../sanitizer.js';

function extractCodexContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c: unknown) => {
        if (typeof c === 'string') return c;
        if (c && typeof c === 'object' && 'text' in c && typeof (c as { text?: unknown }).text === 'string') {
          return (c as { text: string }).text;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

export class CodexAdapter extends BaseContinuumAdapter {
  readonly platform = 'codex' as const;
  readonly label = 'Codex';

  private readonly dbPath = path.join(os.homedir(), '.codex/thread_history_1.sqlite');

  isAvailable(): boolean {
    return fs.existsSync(this.dbPath);
  }

  async listSessions(limit = 100): Promise<ContinuumSessionSummary[]> {
    if (!this.isAvailable()) return [];

    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(this.dbPath, { readOnly: true });
      const rows = db.prepare(`
        SELECT thread_id,
               MIN(created_at_ms) as first_created,
               MAX(created_at_ms) as last_updated,
               COUNT(*) as total_items
        FROM thread_items
        GROUP BY thread_id
        ORDER BY last_updated DESC
        LIMIT ?
      `).all(limit) as Array<{
        thread_id: string;
        first_created: number;
        last_updated: number;
        total_items: number;
      }>;

      const summaries: ContinuumSessionSummary[] = [];

      for (const row of rows) {
        let title = `Codex Thread ${row.thread_id.slice(0, 8)}`;
        let snippet = '';

        try {
          const firstMsg = db.prepare(`
            SELECT item_json FROM thread_items
            WHERE thread_id = ? AND item_type = 'userMessage'
            ORDER BY rollout_ordinal ASC
            LIMIT 1
          `).get(row.thread_id) as { item_json: string } | undefined;

          if (firstMsg?.item_json) {
            const parsed = JSON.parse(firstMsg.item_json);
            const fullText = extractCodexContent(parsed.content);
            if (fullText) {
              title = deriveSessionTitle(fullText, title);
              snippet = fullText.slice(0, 100);
            }
          }
        } catch {
          // Use default title
        }

        summaries.push({
          id: `codex:${row.thread_id}`,
          sourcePlatform: this.platform,
          sourceLabel: this.label,
          title,
          workspacePath: '',
          updatedAt: row.last_updated || row.first_created || Date.now(),
          messageCount: row.total_items,
          snippet
        });
      }

      return summaries;
    } catch {
      return [];
    } finally {
      if (db) {
        try { db.close(); } catch { /* ignore */ }
      }
    }
  }

  async getSession(id: string): Promise<ContinuumSessionDetail | null> {
    if (!this.isAvailable()) return null;
    const rawId = id.startsWith('codex:') ? id.slice('codex:'.length) : id;
    if (!isSafeIdentifier(rawId)) {
      return null;
    }

    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(this.dbPath, { readOnly: true });
      const items = db.prepare(`
        SELECT item_type, created_at_ms, item_json
        FROM thread_items
        WHERE thread_id = ?
        ORDER BY rollout_ordinal ASC, created_at_ms ASC
      `).all(rawId) as Array<{
        item_type: string;
        created_at_ms: number;
        item_json: string;
      }>;

      if (items.length === 0) return null;

      const messages: ContinuumMessage[] = [];
      let sessionTitle = `Codex Thread ${rawId.slice(0, 8)}`;

      for (const item of items) {
        if (!item.item_json) continue;
        try {
          const parsed = JSON.parse(item.item_json);
          const type = item.item_type || parsed.type;
          const text = extractCodexContent(parsed.content);

          if (type === 'userMessage' || type === 'user') {
            const cleaned = cleanUserText(text);
            if (cleaned) {
              if (messages.length === 0) {
                sessionTitle = deriveSessionTitle(cleaned, sessionTitle);
              }
              messages.push({
                role: 'user',
                content: cleaned,
                timestamp: item.created_at_ms
              });
            }
          } else if (type === 'agentMessage' || type === 'assistantMessage' || type === 'assistant') {
            const cleaned = cleanAssistantText(text);
            if (cleaned) {
              messages.push({
                role: 'assistant',
                content: cleaned,
                timestamp: item.created_at_ms
              });
            }
          }
        } catch {
          // Skip corrupt item
        }
      }

      if (messages.length === 0) return null;

      const firstItem = items[0];
      const lastItem = items[items.length - 1];

      return {
        id: `codex:${rawId}`,
        sourcePlatform: this.platform,
        sourceLabel: this.label,
        title: sessionTitle,
        workspacePath: '',
        updatedAt: lastItem?.created_at_ms || firstItem?.created_at_ms || Date.now(),
        messageCount: messages.length,
        snippet: messages[0]?.content.slice(0, 100) || '',
        messages
      };
    } catch {
      return null;
    } finally {
      if (db) {
        try { db.close(); } catch { /* ignore */ }
      }
    }
  }
}
