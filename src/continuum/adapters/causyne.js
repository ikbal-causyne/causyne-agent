// Causyne Native Continuum Adapter: reads sessions through the sovereign session journal.
// Authorship: Strict TypeScript (Causyne Agent).
import fs from 'node:fs';
import path from 'node:path';
import { BaseContinuumAdapter, isSafeIdentifier } from './base.js';
import { listSessions, getSession, SESSION_DIR } from '../../sessionJournal.js';
export class CausyneAdapter extends BaseContinuumAdapter {
    platform = 'causyne';
    label = 'Causyne Agent';
    isAvailable() {
        return fs.existsSync(SESSION_DIR);
    }
    async listSessions(limit = 100) {
        if (!this.isAvailable())
            return [];
        try {
            const records = listSessions();
            return records.slice(0, limit).map(r => ({
                id: `causyne:${r.id}`,
                sourcePlatform: this.platform,
                sourceLabel: this.label,
                title: r.title || 'Untitled Session',
                workspacePath: r.workspace || '',
                updatedAt: r.updatedAt || r.createdAt || Date.now(),
                messageCount: r.messageCount || 1,
                snippet: `Native Causyne session in ${path.basename(r.workspace || '~')}`
            }));
        }
        catch {
            return [];
        }
    }
    async getSession(id) {
        if (!this.isAvailable())
            return null;
        const rawId = id.startsWith('causyne:') ? id.slice('causyne:'.length) : id;
        if (!isSafeIdentifier(rawId)) {
            return null;
        }
        try {
            const record = getSession(rawId);
            if (!record || !record.messages || record.messages.length === 0) {
                return null;
            }
            const messages = record.messages.map(m => ({
                role: m.role === 'user' ? 'user' : (m.role === 'assistant' ? 'assistant' : 'system'),
                content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content || ''),
                timestamp: record.updatedAt
            }));
            return {
                id: `causyne:${record.id}`,
                sourcePlatform: this.platform,
                sourceLabel: this.label,
                title: record.title || 'Untitled Session',
                workspacePath: record.workspace || '',
                updatedAt: record.updatedAt,
                messageCount: messages.length,
                snippet: messages[0]?.content.slice(0, 100) || '',
                messages
            };
        }
        catch {
            return null;
        }
    }
}
