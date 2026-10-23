// OpenCode Continuum Adapter: reads sessions from ~/.local/share/opencode/opencode.db.
// Authorship: Strict TypeScript (Causyne Agent).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { BaseContinuumAdapter, isSafeIdentifier } from './base.js';
import { cleanUserText, cleanAssistantText } from '../sanitizer.js';
export class OpenCodeAdapter extends BaseContinuumAdapter {
    platform = 'opencode';
    label = 'OpenCode';
    dbPath = path.join(os.homedir(), '.local/share/opencode/opencode.db');
    isAvailable() {
        return fs.existsSync(this.dbPath);
    }
    async listSessions(limit = 100) {
        if (!this.isAvailable())
            return [];
        let db = null;
        try {
            db = new DatabaseSync(this.dbPath, { readOnly: true });
            const rows = db.prepare(`
        SELECT id, title, time_created, time_updated, directory
        FROM session
        ORDER BY time_updated DESC
        LIMIT ?
      `).all(limit);
            return rows.map(r => ({
                id: `opencode:${r.id}`,
                sourcePlatform: this.platform,
                sourceLabel: this.label,
                title: r.title || 'Untitled Session',
                workspacePath: r.directory || '',
                updatedAt: r.time_updated || r.time_created || Date.now(),
                messageCount: 1,
                snippet: `OpenCode workspace: ${path.basename(r.directory || '')}`
            }));
        }
        catch {
            return [];
        }
        finally {
            if (db) {
                try {
                    db.close();
                }
                catch { /* ignore */ }
            }
        }
    }
    async getSession(id) {
        if (!this.isAvailable())
            return null;
        const rawId = id.startsWith('opencode:') ? id.slice('opencode:'.length) : id;
        if (!isSafeIdentifier(rawId)) {
            return null;
        }
        let db = null;
        try {
            db = new DatabaseSync(this.dbPath, { readOnly: true });
            const sessionRow = db.prepare(`
        SELECT id, title, time_created, time_updated, directory
        FROM session
        WHERE id = ?
      `).get(rawId);
            if (!sessionRow) {
                return null;
            }
            const messageRows = db.prepare(`
        SELECT m.id, json_extract(m.data, '$.role') as role,
               m.time_created,
               json_extract(p.data, '$.type') as ptype,
               json_extract(p.data, '$.text') as ptext
        FROM message m
        JOIN part p ON m.id = p.message_id
        WHERE m.session_id = ? AND json_extract(p.data, '$.type') = 'text'
        ORDER BY m.time_created ASC, p.id ASC
      `).all(rawId);
            // Group multi-part messages into unified turns
            const grouped = new Map();
            for (const row of messageRows) {
                if (!row.ptext || !row.ptext.trim())
                    continue;
                const existing = grouped.get(row.id);
                if (existing) {
                    existing.texts.push(row.ptext);
                }
                else {
                    grouped.set(row.id, {
                        role: row.role === 'user' ? 'user' : 'assistant',
                        time: row.time_created,
                        texts: [row.ptext]
                    });
                }
            }
            const messages = [];
            for (const item of grouped.values()) {
                const joined = item.texts.join('\n');
                const cleaned = item.role === 'user' ? cleanUserText(joined) : cleanAssistantText(joined);
                if (cleaned) {
                    messages.push({
                        role: item.role,
                        content: cleaned,
                        timestamp: item.time
                    });
                }
            }
            if (messages.length === 0)
                return null;
            return {
                id: `opencode:${sessionRow.id}`,
                sourcePlatform: this.platform,
                sourceLabel: this.label,
                title: sessionRow.title || 'Untitled Session',
                workspacePath: sessionRow.directory || '',
                updatedAt: sessionRow.time_updated || sessionRow.time_created,
                messageCount: messages.length,
                snippet: messages[0]?.content.slice(0, 100) || '',
                messages
            };
        }
        catch {
            return null;
        }
        finally {
            if (db) {
                try {
                    db.close();
                }
                catch { /* ignore */ }
            }
        }
    }
}
