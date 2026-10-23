// Antigravity Continuum Adapter: scans Antigravity IDE and CLI session brains.
// Authorship: Strict TypeScript (Causyne Agent).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { BaseContinuumAdapter, isSafeIdentifier, readBoundedLines } from './base.js';
import type { ContinuumSessionSummary, ContinuumSessionDetail, ContinuumMessage } from '../types.js';
import { cleanUserText, cleanAssistantText } from '../sanitizer.js';

export class AntigravityAdapter extends BaseContinuumAdapter {
  readonly platform = 'antigravity' as const;
  readonly label = 'Antigravity';

  private readonly home = os.homedir();
  private readonly cliSummaryDb = path.join(this.home, '.gemini/antigravity-cli/conversation_summaries.db');
  private readonly ideBrainDir = path.join(this.home, '.gemini/antigravity-ide/brain');
  private readonly cliBrainDir = path.join(this.home, '.gemini/antigravity-cli/brain');

  isAvailable(): boolean {
    return fs.existsSync(this.cliSummaryDb) || fs.existsSync(this.ideBrainDir) || fs.existsSync(this.cliBrainDir);
  }

  async listSessions(limit = 100): Promise<ContinuumSessionSummary[]> {
    const map = new Map<string, ContinuumSessionSummary>();

    // 1. Ingest summaries from SQLite index if present
    if (fs.existsSync(this.cliSummaryDb)) {
      let db: DatabaseSync | null = null;
      try {
        db = new DatabaseSync(this.cliSummaryDb, { readOnly: true });
        const rows = db.prepare(`
          SELECT conversation_id, title, preview, step_count, last_modified_time, workspace_uris
          FROM conversation_summaries
          ORDER BY last_modified_time DESC
          LIMIT ?
        `).all(limit) as Array<{
          conversation_id: string;
          title: string;
          preview: string;
          step_count: number;
          last_modified_time: string;
          workspace_uris: string;
        }>;

        for (const row of rows) {
          if (!row.conversation_id) continue;
          let ws = '';
          try {
            const parsed = JSON.parse(row.workspace_uris);
            ws = Array.isArray(parsed) && parsed[0] ? String(parsed[0]).replace('file://', '') : '';
          } catch {
            ws = row.workspace_uris || '';
          }

          map.set(row.conversation_id, {
            id: `antigravity:${row.conversation_id}`,
            sourcePlatform: this.platform,
            sourceLabel: this.label,
            title: row.title || 'Untitled Session',
            workspacePath: ws,
            updatedAt: new Date(row.last_modified_time).getTime() || Date.now(),
            messageCount: row.step_count || 1,
            snippet: row.preview || ''
          });
        }
      } catch {
        // Best-effort read
      } finally {
        if (db) {
          try { db.close(); } catch { /* ignore */ }
        }
      }
    }

    // 2. Scan IDE and CLI brain transcripts for active sessions
    const scanDirs = [
      { dir: this.ideBrainDir, label: 'IDE' },
      { dir: this.cliBrainDir, label: 'CLI' }
    ];

    for (const { dir } of scanDirs) {
      if (!fs.existsSync(dir)) continue;
      try {
        const entries = fs.readdirSync(dir);
        for (const cid of entries) {
          if (!isSafeIdentifier(cid)) continue;
          const tpath = path.join(dir, cid, '.system_generated/logs/transcript.jsonl');
          if (!fs.existsSync(tpath)) continue;

          if (map.has(cid)) continue;

          try {
            const stat = fs.statSync(tpath);
            map.set(cid, {
              id: `antigravity:${cid}`,
              sourcePlatform: this.platform,
              sourceLabel: this.label,
              title: `Session ${cid.slice(0, 8)}`,
              workspacePath: '',
              updatedAt: stat.mtimeMs,
              messageCount: 1,
              snippet: 'Antigravity conversation transcript'
            });
          } catch {
            // Skip unreadable
          }
        }
      } catch {
        // Skip unreadable
      }
    }

    return Array.from(map.values())
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
  }

  async getSession(id: string): Promise<ContinuumSessionDetail | null> {
    const rawId = id.startsWith('antigravity:') ? id.slice('antigravity:'.length) : id;
    if (!isSafeIdentifier(rawId)) {
      return null;
    }

    // Search for transcript in ide brain, cli brain, or legacy
    const bases = [
      this.ideBrainDir,
      this.cliBrainDir,
      path.join(this.home, '.gemini/antigravity/brain')
    ];

    let tpath: string | null = null;
    for (const base of bases) {
      const candidate = path.join(base, rawId, '.system_generated/logs/transcript.jsonl');
      if (path.resolve(candidate).startsWith(base) && fs.existsSync(candidate)) {
        tpath = candidate;
        break;
      }
    }

    if (!tpath) return null;

    const messages: ContinuumMessage[] = [];
    let title = `Antigravity Session ${rawId.slice(0, 8)}`;
    const workspace = '';

    try {
      const lines = readBoundedLines(tpath);

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const data = JSON.parse(line);
          const type = data.type;
          const text = data.content || '';

          if (type === 'USER_INPUT') {
            const cleaned = cleanUserText(text);
            if (cleaned) {
              if (messages.length === 0) {
                const firstLine = cleaned.split('\n')[0] || '';
                if (firstLine.trim()) title = firstLine.trim().slice(0, 60);
              }
              messages.push({
                role: 'user',
                content: cleaned,
                timestamp: data.created_at ? new Date(data.created_at).getTime() : Date.now()
              });
            }
          } else if (type === 'PLANNER_RESPONSE') {
            const cleaned = cleanAssistantText(text);
            if (cleaned) {
              messages.push({
                role: 'assistant',
                content: cleaned,
                timestamp: data.created_at ? new Date(data.created_at).getTime() : Date.now()
              });
            }
          }
        } catch {
          // Skip torn JSON line
        }
      }
    } catch {
      return null;
    }

    if (messages.length === 0) return null;

    const stat = fs.statSync(tpath);
    return {
      id: `antigravity:${rawId}`,
      sourcePlatform: this.platform,
      sourceLabel: this.label,
      title,
      workspacePath: workspace,
      updatedAt: stat.mtimeMs,
      messageCount: messages.length,
      snippet: messages[0]?.content.slice(0, 100) || '',
      messages
    };
  }
}
