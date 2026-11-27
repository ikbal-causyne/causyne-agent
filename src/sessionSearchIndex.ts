/**
 * Causyne Agent — Disposable SQLite FTS5 Session Search Index & Tool
 *
 * Indexes workspace-scoped JSONL session transcripts under `~/.causyne/sessions/`
 * using Node's built-in `node:sqlite` FTS5 (zero external npm dependencies) with
 * automatic fallback to linear streaming scan if SQLite FTS5 is unavailable.
 */

import fs from 'node:fs';
import path from 'node:path';
import { listSessions, getSession } from './sessionJournal.js';
import { physicalPath } from './agent/workspaceBoundary.js';
import { causyneHome } from './utils/paths.js';
import {
  boundedInteger,
  resolveToolWorkspaceRoots,
  sanitizeToolError,
  type ToolWorkspaceContext
} from './tools/toolPathSafety.js';

export interface SessionSearchHit {
  sessionId: string;
  title: string;
  updatedAt: number;
  messageIndex: number;
  role: string;
  snippet: string;
  score: number;
}

const INDEX_SCHEMA_VERSION = 1;
const MAX_SNIPPET_CHARS = 240;

function extractMessagePlainText(msg: unknown): string {
  if (!msg || typeof msg !== 'object') return '';
  const rec = msg as { content?: unknown };
  if (typeof rec.content === 'string') return rec.content;
  if (Array.isArray(rec.content)) {
    const parts: string[] = [];
    for (const block of rec.content) {
      if (typeof block === 'string') parts.push(block);
      else if (block && typeof block === 'object' && typeof (block as { text?: unknown }).text === 'string') {
        parts.push((block as { text: string }).text);
      }
    }
    return parts.join('\n');
  }
  return '';
}

function buildMatchSnippet(text: string, query: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= MAX_SNIPPET_CHARS) return cleaned;
  const lower = cleaned.toLowerCase();
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  let pos = -1;
  for (const term of terms) {
    const found = lower.indexOf(term);
    if (found !== -1 && (pos === -1 || found < pos)) pos = found;
  }
  if (pos === -1) return `${cleaned.slice(0, MAX_SNIPPET_CHARS)}...`;
  const start = Math.max(0, pos - 70);
  const end = Math.min(cleaned.length, start + MAX_SNIPPET_CHARS);
  return `${start > 0 ? '...' : ''}${cleaned.slice(start, end)}${end < cleaned.length ? '...' : ''}`;
}

function quoteFtsQuery(rawQuery: string): string {
  const tokens = rawQuery
    .trim()
    .split(/\s+/)
    .map((t) => t.replace(/"/g, '').trim())
    .filter((t) => t.length > 0)
    .slice(0, 12);
  if (tokens.length === 0) return '';
  return tokens.map((t) => `"${t}"`).join(' AND ');
}

function sameWorkspace(sessionWorkspace: string, workspaceRoot: string): boolean {
  if (!sessionWorkspace) return false;
  const a = physicalPath(sessionWorkspace) || path.resolve(sessionWorkspace);
  const b = physicalPath(workspaceRoot) || path.resolve(workspaceRoot);
  return a === b;
}

async function searchWithSqliteFts5(
  workspaceRoot: string,
  query: string,
  options: { limit: number; excludeSessionId?: string | undefined }
): Promise<SessionSearchHit[] | null> {
  let DatabaseSyncCtor: any;
  try {
    const mod = await import('node:sqlite');
    DatabaseSyncCtor = (mod as { DatabaseSync?: unknown }).DatabaseSync;
  } catch {
    return null;
  }
  if (typeof DatabaseSyncCtor !== 'function') return null;

  const ftsQuery = quoteFtsQuery(query);
  if (!ftsQuery) return [];

  const indexDir = path.join(causyneHome(), 'cache');
  const dbPath = path.join(indexDir, 'session-search-fts5.sqlite');
  fs.mkdirSync(indexDir, { recursive: true, mode: 0o700 });

  const db = new DatabaseSyncCtor(dbPath);
  try {
    const verRow = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
    if (!verRow || verRow.user_version !== INDEX_SCHEMA_VERSION) {
      db.exec('DROP TABLE IF EXISTS session_meta; DROP TABLE IF EXISTS session_docs;');
      db.exec(`
        CREATE TABLE session_meta (
          session_id TEXT PRIMARY KEY,
          workspace TEXT NOT NULL,
          title TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          message_count INTEGER NOT NULL
        );
        CREATE VIRTUAL TABLE session_docs USING fts5(
          session_id UNINDEXED,
          workspace UNINDEXED,
          title,
          role UNINDEXED,
          message_index UNINDEXED,
          body,
          tokenize='unicode61'
        );
        PRAGMA user_version = ${INDEX_SCHEMA_VERSION};
      `);
    }

    const sessions = listSessions().filter((s) => sameWorkspace(s.workspace, workspaceRoot));
    const selectMeta = db.prepare('SELECT updated_at, message_count FROM session_meta WHERE session_id = ?');
    const deleteDocs = db.prepare('DELETE FROM session_docs WHERE session_id = ?');
    const upsertMeta = db.prepare(
      'INSERT OR REPLACE INTO session_meta (session_id, workspace, title, updated_at, message_count) VALUES (?, ?, ?, ?, ?)'
    );
    const insertDoc = db.prepare(
      'INSERT INTO session_docs (session_id, workspace, title, role, message_index, body) VALUES (?, ?, ?, ?, ?, ?)'
    );

    const normalizedWorkspace = physicalPath(workspaceRoot) || path.resolve(workspaceRoot);
    for (const summary of sessions.slice(0, 120)) {
      const existing = selectMeta.get(summary.id) as { updated_at?: number; message_count?: number } | undefined;
      if (existing && existing.updated_at === summary.updatedAt && existing.message_count === summary.messageCount) {
        continue;
      }
      const full = getSession(summary.id);
      if (!full) continue;
      deleteDocs.run(summary.id);
      upsertMeta.run(summary.id, normalizedWorkspace, summary.title || '', summary.updatedAt || 0, full.messages.length);
      for (let i = 0; i < full.messages.length; i++) {
        const msg = full.messages[i];
        const body = extractMessagePlainText(msg).slice(0, 16_000);
        if (!body.trim()) continue;
        insertDoc.run(
          summary.id,
          normalizedWorkspace,
          summary.title || '',
          String(msg?.role || 'unknown'),
          i,
          body
        );
      }
    }

    const rows = db.prepare(`
      SELECT d.session_id, d.title, d.role, d.message_index, d.body, m.updated_at, bm25(session_docs) AS rank
      FROM session_docs d
      JOIN session_meta m ON m.session_id = d.session_id
      WHERE d.workspace = ? AND session_docs MATCH ?
      ORDER BY rank ASC, m.updated_at DESC
      LIMIT ?
    `).all(normalizedWorkspace, ftsQuery, Math.max(options.limit * 4, 24)) as Array<{
      session_id: string;
      title: string;
      role: string;
      message_index: number;
      body: string;
      updated_at: number;
      rank: number;
    }>;

    const bestPerSession = new Map<string, SessionSearchHit>();
    for (const row of rows) {
      if (options.excludeSessionId && row.session_id === options.excludeSessionId) continue;
      if (bestPerSession.has(row.session_id)) continue;
      bestPerSession.set(row.session_id, {
        sessionId: row.session_id,
        title: row.title || 'Untitled session',
        updatedAt: Number(row.updated_at || 0),
        messageIndex: Number(row.message_index || 0),
        role: row.role || 'unknown',
        snippet: buildMatchSnippet(row.body || '', query),
        score: Number.isFinite(row.rank) ? -row.rank : 0
      });
      if (bestPerSession.size >= options.limit) break;
    }

    return [...bestPerSession.values()];
  } finally {
    try { db.close(); } catch { /* ignore */ }
  }
}

function searchLinearFallback(
  workspaceRoot: string,
  query: string,
  options: { limit: number; excludeSessionId?: string | undefined }
): SessionSearchHit[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const sessions = listSessions().filter((s) => sameWorkspace(s.workspace, workspaceRoot));
  const hits: SessionSearchHit[] = [];

  for (const summary of sessions.slice(0, 120)) {
    if (options.excludeSessionId && summary.id === options.excludeSessionId) continue;
    const full = getSession(summary.id);
    if (!full) continue;
    for (let i = full.messages.length - 1; i >= 0; i--) {
      const msg = full.messages[i];
      const text = extractMessagePlainText(msg);
      const lower = text.toLowerCase();
      if (terms.every((t) => lower.includes(t))) {
        hits.push({
          sessionId: summary.id,
          title: summary.title || 'Untitled session',
          updatedAt: summary.updatedAt || 0,
          messageIndex: i,
          role: String(msg?.role || 'unknown'),
          snippet: buildMatchSnippet(text, query),
          score: 1
        });
        break;
      }
    }
    if (hits.length >= options.limit) break;
  }
  return hits;
}

export async function searchWorkspaceSessions(
  workspaceRoot: string,
  query: string,
  options: { limit?: number | undefined; excludeSessionId?: string | undefined } = {}
): Promise<SessionSearchHit[]> {
  const trimmed = String(query || '').trim();
  if (!trimmed) return [];
  const limit = boundedInteger(options.limit, 8, 1, 25);
  try {
    const fts = await searchWithSqliteFts5(workspaceRoot, trimmed, {
      limit,
      excludeSessionId: options.excludeSessionId
    });
    if (fts !== null) return fts;
  } catch {
    // Fall back gracefully if SQLite FTS5 is unavailable
  }
  return searchLinearFallback(workspaceRoot, trimmed, {
    limit,
    excludeSessionId: options.excludeSessionId
  });
}

export const sessionSearchTool = {
  schema: {
    name: 'session_search',
    description:
      'Full-text search across prior saved Causyne sessions in the current workspace (backed by disposable SQLite FTS5). Use to recall prior decisions, commands, file changes, or error resolutions.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keywords or phrase (1-300 characters).' },
        limit: { type: 'integer', description: 'Maximum sessions to return (1-25, default 8).' }
      },
      required: ['query'],
      additionalProperties: false
    }
  },

  async execute(
    args: { query?: string; limit?: number },
    context: ToolWorkspaceContext & { parentLoop?: { sessionId?: string | undefined } | undefined } = {}
  ) {
    try {
      const query = typeof args?.query === 'string' ? args.query.trim() : '';
      if (!query || query.length > 300) {
        return { success: false, error: 'query must contain 1-300 characters.' };
      }
      const scope = resolveToolWorkspaceRoots(context);
      const workspaceRoot = scope.primaryRoot || process.cwd();
      const hits = await searchWorkspaceSessions(workspaceRoot, query, {
        limit: args.limit,
        excludeSessionId: context.parentLoop?.sessionId
      });
      if (hits.length === 0) {
        return { success: true, hits: [], output: `No matching prior sessions found for "${query}".` };
      }
      const lines = hits.map(
        (h, idx) => `${idx + 1}. [${h.sessionId}] ${h.title} (msg #${h.messageIndex}, ${h.role})\n   ${h.snippet}`
      );
      return {
        success: true,
        hits,
        output: `Found ${hits.length} matching session(s):\n${lines.join('\n')}`
      };
    } catch (error) {
      return { success: false, error: sanitizeToolError(error) };
    }
  }
};
