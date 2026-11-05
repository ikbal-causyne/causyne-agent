import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { causyneHome } from '../utils/paths.js';
import { openCortexDatabase, computeNativeEmbedding, computeSimilarityScore, readExtendedMemoryStats } from './cortexEngine.js';
// Diagnostics, off by default: console output during a turn overwrites the
// prompt's live region. See src/cortex/provisioner.js for the full reason.
function debugLog(message) {
    if (process.env.CAUSYNE_DEBUG !== '1')
        return;
    process.stderr.write(`[causyne] ${message}\n`);
}
const CORTEX_DIR = causyneHome();
const CORTEX_DB_FILE = path.join(CORTEX_DIR, 'cortex.db');
/**
 * How long a memory keeps half its weight. Thirty days.
 *
 * A lesson from last week is usually about the code as it is now; one from
 * March is usually about code that no longer exists. Decay does not delete it —
 * it just stops an ancient memory outranking a recent one on a tie.
 */
const RECENCY_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * OBLIVION adaptive memory stability constants:
 * S = BASE_HALF_LIFE * (1 + hits * REINFORCEMENT_ALPHA) * tierMultiplier
 * R = e^(-t/S) — adaptive retention that rewards retrieved memories with slower decay
 */
const REINFORCEMENT_ALPHA = 0.2;
const TIER_MULTIPLIERS = {
    condensed: 2.0, // L1: Topic summaries persist longer
    creative: 1.5, // L2: Creative successes are valuable
    mistake: 1.0 // L3: Mistakes decay normally unless reinforced
};
/** Similarity below this is noise, whatever the recency. */
const MIN_SIMILARITY = 0.18;
/** Rows scored per search. Beyond this the newest win, so search stays O(1)-ish. */
const MAX_CANDIDATES = 500;
/** Ceiling on stored memories per workspace before the oldest are retired. */
const MAX_MEMORIES_PER_WORKSPACE = 2000;
/**
 * Common continuation, affirmation, or trivial words that must NEVER trigger
 * historical memory injection. Searching Cortex on "continue" or "next" is what
 * caused catastrophic task hijacking hallucinations (e.g. Suika project bug).
 */
const CONTINUATION_WORDS_PATTERN = /^(continue|next|proceed|ok|go|fix|retry|more|run|yes|y|lanjut|teruskan|buka|open|open it)\b/i;
/**
 * Evaluates whether a prompt carries substantive task content eligible for Cortex retrieval.
 */
export function isSearchablePrompt(prompt) {
    if (typeof prompt !== 'string')
        return false;
    const trimmed = prompt.trim();
    if (trimmed.length < 15)
        return false;
    if (CONTINUATION_WORDS_PATTERN.test(trimmed) && trimmed.length < 30)
        return false;
    return true;
}
/** The dedup key: same lesson, same row, however many times it is learned. */
function fingerprintOf(text) {
    const normalised = String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();
    return crypto.createHash('sha256').update(normalised).digest('hex').slice(0, 32);
}
/** Type as a COLUMN, not as a prefix a LIKE has to scan for. */
function kindOf(text) {
    const value = String(text || '');
    if (value.startsWith('CREATIVE SUCCESS:'))
        return 'creative';
    if (value.startsWith('[PAST MISTAKE'))
        return 'mistake';
    return 'condensed';
}
export class VectorDB {
    extractor = null;
    isInitialized = false;
    isNeural = false;
    db = null;
    async ensureDb() {
        if (this.db)
            return;
        if (!fs.existsSync(CORTEX_DIR)) {
            fs.mkdirSync(CORTEX_DIR, { recursive: true, mode: 0o700 });
        }
        this.db = await openCortexDatabase(CORTEX_DB_FILE);
        // Create the task_memories table if it doesn't exist
        // embedding_vector is stored as a JSON string array of floats
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_memories (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        embedding_vector TEXT NOT NULL,
        timestamp INTEGER NOT NULL
      )
    `);
        this.migrateSchema();
    }
    /**
     * Bring an existing store up to the current schema, additively.
     */
    migrateSchema() {
        if (!this.db)
            return;
        const columns = new Set(this.db.prepare('PRAGMA table_info(task_memories)').all().map((c) => c.name));
        if (!columns.has('workspace'))
            this.db.exec("ALTER TABLE task_memories ADD COLUMN workspace TEXT DEFAULT ''");
        if (!columns.has('kind'))
            this.db.exec("ALTER TABLE task_memories ADD COLUMN kind TEXT DEFAULT 'mistake'");
        if (!columns.has('fingerprint'))
            this.db.exec('ALTER TABLE task_memories ADD COLUMN fingerprint TEXT');
        if (!columns.has('hits'))
            this.db.exec('ALTER TABLE task_memories ADD COLUMN hits INTEGER DEFAULT 0');
        // Backfill derived columns for legacy rows
        const stale = this.db.prepare('SELECT id, text FROM task_memories WHERE fingerprint IS NULL').all();
        if (stale.length > 0) {
            const setRow = this.db.prepare('UPDATE task_memories SET fingerprint = ?, kind = ? WHERE id = ?');
            const run = this.db.transaction((rows) => {
                for (const row of rows)
                    setRow.run(fingerprintOf(row.text), kindOf(row.text), row.id);
            });
            run(stale);
        }
        // Collapse legacy duplicates
        const groups = this.db.prepare(`SELECT fingerprint, workspace, COUNT(*) c FROM task_memories
        WHERE fingerprint IS NOT NULL
        GROUP BY fingerprint, workspace HAVING c > 1`).all();
        if (groups.length > 0) {
            const db = this.db;
            const collapse = db.transaction((rows) => {
                for (const group of rows) {
                    const copies = db.prepare(`SELECT id, hits FROM task_memories
              WHERE fingerprint = ? AND workspace = ? ORDER BY timestamp DESC`).all(group.fingerprint, group.workspace);
                    const keep = copies[0];
                    if (!keep)
                        continue;
                    const totalHits = copies.reduce((sum, row) => sum + (row.hits || 0), 0);
                    db.prepare('UPDATE task_memories SET hits = ? WHERE id = ?').run(totalHits, keep.id);
                    for (const row of copies.slice(1)) {
                        db.prepare('DELETE FROM task_memories WHERE id = ?').run(row.id);
                    }
                }
            });
            collapse(groups);
            debugLog(`[CORTEX] collapsed ${groups.length} duplicate group(s)`);
        }
        // Indices for instant lookup
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_memories_ws_time ON task_memories(workspace, timestamp DESC)');
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_memories_kind ON task_memories(kind, timestamp DESC)');
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_memories_fingerprint ON task_memories(fingerprint, workspace)');
    }
    async init() {
        if (this.isInitialized)
            return;
        await this.ensureDb();
        this.extractor = null;
        this.isNeural = false;
        this.isInitialized = true;
    }
    async embed(text) {
        if (!this.isInitialized)
            await this.init();
        return computeNativeEmbedding(text);
    }
    cosineSimilarity(vecA, vecB) {
        let dotProduct = 0;
        let normA = 0;
        let normB = 0;
        const len = Math.min(vecA.length, vecB.length);
        for (let i = 0; i < len; i++) {
            const a = vecA[i] ?? 0;
            const b = vecB[i] ?? 0;
            dotProduct += a * b;
            normA += a * a;
            normB += b * b;
        }
        if (normA === 0 || normB === 0)
            return 0;
        return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    }
    /**
     * A mistake and how it was recovered from. Scoped to the project it happened in.
     */
    async saveMemory(taskGoal, errorEncountered, resolution, workspace = process.cwd()) {
        const searchableText = `Goal: ${taskGoal}\nError: ${errorEncountered}`;
        const fullText = `[PAST MISTAKE RECOVERED]\nGoal: ${taskGoal}\nError: ${errorEncountered}\nResolution: ${resolution}`;
        const result = await this.upsertMemory(fullText, { workspace, kind: 'mistake', searchableText });
        debugLog(`[CORTEX] mistake ${result.created ? 'recorded' : 'reinforced'}`);
        return result;
    }
    /** A condensed run of chat history, kept against the project it summarises. */
    async saveCondensedMemory(summaryText, workspace = process.cwd()) {
        const fullText = `[CONDENSED CHAT HISTORY]\n${summaryText}`;
        return this.upsertMemory(fullText, { workspace, kind: 'condensed' });
    }
    async search(queryText, topK = 3, options = {}) {
        // Guard against continuation / short queries to prevent task hijacking hallucinations
        if (!isSearchablePrompt(queryText)) {
            return [];
        }
        await this.ensureDb();
        if (!this.db)
            return [];
        const workspace = String(options.workspace ?? process.cwd() ?? '');
        const rows = this.db.prepare(`SELECT id, text, embedding_vector, timestamp, kind, hits
         FROM task_memories
        WHERE workspace = ? OR workspace = ''
        ORDER BY timestamp DESC
        LIMIT ?`).all(workspace, MAX_CANDIDATES);
        if (rows.length === 0)
            return [];
        const queryEmbedding = await this.embed(queryText);
        const now = Date.now();
        const scored = [];
        for (const memory of rows) {
            let similarity;
            try {
                const memVec = JSON.parse(memory.embedding_vector);
                similarity = computeSimilarityScore(queryEmbedding, memVec, queryText, memory.text, Boolean(this.isNeural));
            }
            catch (_e) {
                continue; // a corrupt vector is skipped, never fatal
            }
            if (similarity <= MIN_SIMILARITY)
                continue;
            const ageMs = Math.max(0, now - (memory.timestamp || 0));
            // OBLIVION: S = BASE_HALF_LIFE * (1 + hits * REINFORCEMENT_ALPHA) * tierMultiplier
            // R = e^(-t/S) — adaptive retention that rewards reinforced memories with slower decay
            const tierMult = TIER_MULTIPLIERS[memory.kind] ?? 1.0;
            const stability = Math.max(1, RECENCY_HALF_LIFE_MS * (1 + (memory.hits || 0) * REINFORCEMENT_ALPHA) * tierMult);
            const retention = Math.exp(-ageMs / stability);
            scored.push({
                id: memory.id,
                text: memory.text,
                kind: memory.kind,
                timestamp: memory.timestamp,
                hits: memory.hits || 0,
                similarity,
                retention,
                score: similarity * retention
            });
        }
        scored.sort((a, b) => b.score - a.score);
        const matches = scored.slice(0, topK);
        // Reinforce retrieved memories: incrementing hits increases memory stability S
        if (matches.length > 0) {
            try {
                const bump = this.db.prepare('UPDATE task_memories SET hits = hits + 1 WHERE id = ?');
                const run = this.db.transaction((ids) => { for (const id of ids)
                    bump.run(id); });
                run(matches.map(m => m.id));
            }
            catch (_e) { /* telemetry must never fail a retrieval */ }
        }
        return matches;
    }
    /**
     * Write a memory, or refresh the one that already says this.
     */
    async upsertMemory(text, { workspace = '', kind = null, searchableText = null } = {}) {
        await this.ensureDb();
        if (!this.db)
            throw new Error('Database not initialized');
        const fingerprint = fingerprintOf(text);
        const scope = String(workspace || '');
        const existing = this.db.prepare('SELECT id FROM task_memories WHERE fingerprint = ? AND workspace = ?').get(fingerprint, scope);
        if (existing) {
            this.db.prepare('UPDATE task_memories SET timestamp = ?, hits = hits + 1 WHERE id = ?')
                .run(Date.now(), existing.id);
            debugLog(`[CORTEX] memory reinforced rather than duplicated: ${fingerprint.slice(0, 8)}`);
            return { id: existing.id, created: false };
        }
        const embedding = await this.embed(searchableText || text);
        const id = `mem_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
        this.db.prepare(`INSERT INTO task_memories (id, text, embedding_vector, timestamp, workspace, kind, fingerprint, hits)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`).run(id, text, JSON.stringify(embedding), Date.now(), scope, kind || kindOf(text), fingerprint);
        this.pruneWorkspace(scope);
        return { id, created: true };
    }
    /**
     * Retire the least useful memories once a workspace passes its ceiling.
     */
    pruneWorkspace(workspace, max = MAX_MEMORIES_PER_WORKSPACE) {
        if (!this.db)
            return 0;
        try {
            const { c } = this.db.prepare('SELECT COUNT(*) c FROM task_memories WHERE workspace = ?').get(workspace);
            if (c <= max)
                return 0;
            const result = this.db.prepare(`DELETE FROM task_memories WHERE id IN (
           SELECT id FROM task_memories WHERE workspace = ?
            ORDER BY hits ASC, timestamp ASC LIMIT ?
         )`).run(workspace, c - max);
            return result.changes;
        }
        catch (_e) {
            return 0;
        }
    }
    /** Everything stored, for `/cortex`. Vectors excluded — they are unreadable. */
    async inventory(options = {}) {
        await this.ensureDb();
        if (!this.db)
            return [];
        const workspace = options.workspace;
        const rows = workspace
            ? this.db.prepare(`SELECT id, text, kind, timestamp, hits, workspace FROM task_memories
            WHERE workspace = ? OR workspace = '' ORDER BY timestamp DESC LIMIT 200`).all(String(workspace))
            : this.db.prepare('SELECT id, text, kind, timestamp, hits, workspace FROM task_memories ORDER BY timestamp DESC LIMIT 200').all();
        return rows;
    }
    /** Counts, for a one-line answer to "is my digital brain actually on?". */
    async stats() {
        await this.ensureDb();
        if (!this.db)
            throw new Error('Database not initialized');
        const total = this.db.prepare('SELECT COUNT(*) c FROM task_memories').get().c;
        const byKind = this.db.prepare('SELECT kind, COUNT(*) c FROM task_memories GROUP BY kind').all();
        const workspaces = this.db.prepare("SELECT COUNT(DISTINCT workspace) c FROM task_memories WHERE workspace != ''").get().c;
        const newest = this.db.prepare('SELECT MAX(timestamp) t FROM task_memories').get().t || 0;
        const distinct = this.db.prepare('SELECT COUNT(DISTINCT fingerprint) c FROM task_memories').get().c;
        const extended = readExtendedMemoryStats();
        return {
            total,
            distinct,
            byKind,
            workspaces,
            newest,
            isNeural: Boolean(this.isNeural),
            engineType: 'native (semantic vector + sqlite)',
            episodicCount: extended.episodicCount,
            factsCount: extended.factsCount
        };
    }
    /** Forget one memory, or every memory in a workspace. */
    async forget({ id = null, workspace = null } = {}) {
        await this.ensureDb();
        if (!this.db)
            return 0;
        if (id)
            return this.db.prepare('DELETE FROM task_memories WHERE id = ?').run(id).changes;
        if (workspace !== null) {
            return this.db.prepare('DELETE FROM task_memories WHERE workspace = ?').run(String(workspace)).changes;
        }
        return 0;
    }
    /**
     * A design approach that worked, so the next one deliberately differs.
     */
    async saveCreativePattern(pattern) {
        const text = `CREATIVE SUCCESS: Built "${pattern.project}" using ${pattern.designApproach} style. Colors: ${pattern.colorPalette}. Fonts: ${pattern.fonts}.`;
        const result = await this.upsertMemory(text, { workspace: '', kind: 'creative' });
        debugLog(`[CORTEX] creative pattern ${result.created ? 'saved' : 'reinforced'}: ${pattern.designApproach}`);
        return result;
    }
    // Anti-Slop: Retrieve recent creative patterns for the "DO NOT REPEAT" directive
    async getRecentCreativePatterns(limit = 5) {
        await this.ensureDb();
        if (!this.db)
            return [];
        try {
            const results = this.db.prepare('SELECT text FROM task_memories WHERE kind = ? ORDER BY timestamp DESC LIMIT ?').all('creative', limit);
            return results.map((r) => r.text);
        }
        catch (_e) {
            return [];
        }
    }
}
export const cortexDb = new VectorDB();
