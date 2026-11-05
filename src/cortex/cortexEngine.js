/**
 * Sovereign Cortex Engine — Native Zero-Dependency SQLite & Semantic Vectors.
 *
 * Provides instant, production-grade memory persistence and semantic vector retrieval
 * across all development environments and platforms with zero required npm packages,
 * while automatically leveraging `@xenova/transformers` when provisioned.
 */
import fs from 'node:fs';
import path from 'node:path';
import { causyneHome } from '../utils/paths.js';
/**
 * Open or create the SQLite database for Cortex using native Node SQLite or better-sqlite3.
 */
export async function openCortexDatabase(dbPath) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    // 1. Prefer Node.js native `node:sqlite` (Node 22+)
    try {
        const sqliteModule = await import('node:sqlite');
        if (sqliteModule && typeof sqliteModule.DatabaseSync === 'function') {
            const dbInstance = new sqliteModule.DatabaseSync(dbPath);
            // Ensure transaction helper is available
            if (typeof dbInstance.transaction !== 'function') {
                dbInstance.transaction = function (fn) {
                    return function (...args) {
                        dbInstance.exec('BEGIN IMMEDIATE');
                        try {
                            const res = fn(...args);
                            dbInstance.exec('COMMIT');
                            return res;
                        }
                        catch (err) {
                            try {
                                dbInstance.exec('ROLLBACK');
                            }
                            catch (_) { }
                            throw err;
                        }
                    };
                };
            }
            return dbInstance;
        }
    }
    catch (_e) {
        // Native node:sqlite unavailable or disabled; fall through to optional provider
    }
    // 2. Check for optional better-sqlite3 in cortex package
    try {
        const { requireCortexModule } = await import('./provisioner.js');
        const DatabaseConstructor = await requireCortexModule('better-sqlite3');
        if (DatabaseConstructor) {
            return new DatabaseConstructor(dbPath);
        }
    }
    catch (_e) {
        // better-sqlite3 not provisioned
    }
    throw new Error('SQLite engine unavailable. Node 22+ with node:sqlite or better-sqlite3 is required for Cortex.');
}
/**
 * Deterministic string hash (FNV-1a 32-bit).
 */
function fnv1a32(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619) >>> 0;
    }
    return h;
}
/**
 * Native, zero-dependency 128-dimensional semantic feature hashing embedding.
 * Captures word tokens, character trigrams, and morphology with unit L2 normalization.
 */
export function computeNativeEmbedding(text, dims = 128) {
    const vec = new Float64Array(dims);
    const words = String(text || '').toLowerCase().match(/[a-z0-9_#.-]+/g) || [];
    for (const word of words) {
        const h = fnv1a32(word);
        const idx = h % dims;
        const sign = (fnv1a32(word + '_s') & 1) ? 1 : -1;
        vec[idx] = (vec[idx] ?? 0) + sign * 2.0;
        if (word.length >= 3) {
            for (let i = 0; i <= word.length - 3; i++) {
                const tri = word.slice(i, i + 3);
                const th = fnv1a32(tri);
                const tidx = th % dims;
                const tsign = (fnv1a32(tri + '_s') & 1) ? 1 : -1;
                vec[tidx] = (vec[tidx] ?? 0) + tsign * 0.5;
            }
        }
    }
    let norm = 0;
    for (let i = 0; i < dims; i++) {
        const v = vec[i] ?? 0;
        norm += v * v;
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
        for (let i = 0; i < dims; i++) {
            vec[i] = (vec[i] ?? 0) / norm;
        }
    }
    return Array.from(vec);
}
/**
 * Exact cosine similarity between two float vectors.
 */
export function cosineSimilarity(vecA, vecB) {
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
 * Compute hybrid similarity between query and stored memory.
 */
export function computeSimilarityScore(queryEmbedding, memoryEmbedding, queryText, memoryText, isNeural) {
    const cosine = Math.max(0, cosineSimilarity(queryEmbedding, memoryEmbedding));
    if (isNeural)
        return cosine;
    // For native semantic vectors: incorporate token and subword stem overlap
    const qWords = String(queryText || '').toLowerCase().match(/[a-z0-9_-]+/g) || [];
    const mWords = new Set(String(memoryText || '').toLowerCase().match(/[a-z0-9_-]+/g) || []);
    let matches = 0;
    for (const w of qWords) {
        if (mWords.has(w)) {
            matches++;
        }
        else if (w.length >= 4) {
            for (const mw of mWords) {
                if (mw.length >= 4 && (mw.includes(w) || w.includes(mw))) {
                    matches += 0.8;
                    break;
                }
            }
        }
    }
    const overlapRatio = qWords.length > 0 ? (matches / qWords.length) : 0;
    return (cosine * 0.4) + (overlapRatio * 0.6);
}
/**
 * Read memory stats from episodic and long-term facts stores.
 */
export function readExtendedMemoryStats() {
    let episodicCount = 0;
    let factsCount = 0;
    const home = causyneHome();
    try {
        const episodicFile = path.join(home, 'episodic-memory.json');
        if (fs.existsSync(episodicFile)) {
            const data = JSON.parse(fs.readFileSync(episodicFile, 'utf8'));
            episodicCount = Array.isArray(data.observations) ? data.observations.length : 0;
        }
    }
    catch (_) { }
    try {
        const factsFile = path.join(home, 'memory.json');
        if (fs.existsSync(factsFile)) {
            const data = JSON.parse(fs.readFileSync(factsFile, 'utf8'));
            factsCount = Array.isArray(data.facts) ? data.facts.length : 0;
        }
    }
    catch (_) { }
    return { episodicCount, factsCount };
}
