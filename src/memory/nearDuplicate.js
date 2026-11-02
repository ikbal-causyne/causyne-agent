/**
 * @file src/memory/nearDuplicate.ts
 * 2-Tier Deterministic Near-Duplicate Observation Detector with Rare-Token IDF Veto.
 *
 * Tier-0 (`exact`): Normalized non-empty title equality triggers silent reinforcement.
 * Tier-1 (`candidate`): IDF-weighted cosine similarity >= threshold with a minimum
 *   shared-token guard (`minSharedTokens: 2`) AND a rare-token IDF Veto (if the
 *   symmetric difference contains a rare high-IDF token such as a distinct filename,
 *   symbol, or error code, the merge is vetoed).
 *
 * Authorship: Strict TypeScript (Causyne Agent).
 */
const DEFAULT_SIMILARITY_THRESHOLD = 0.72;
const DEFAULT_MIN_SHARED_TOKENS = 2;
const DEFAULT_IDF_VETO_RATIO = 0.85;
const STOPWORDS = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of',
    'with', 'by', 'from', 'up', 'about', 'into', 'over', 'after', 'is', 'are',
    'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does',
    'did', 'will', 'would', 'shall', 'should', 'may', 'might', 'must', 'can',
    'could', 'this', 'that', 'these', 'those', 'it', 'its', 'as', 'if', 'when',
    'than', 'then', 'so', 'no', 'not', 'only', 'own', 'same', 'too', 'very',
    'via', 'using', 'used', 'file', 'files', 'tool', 'ran', 'run', 'executed'
]);
/**
 * Normalize an observation title for Tier-0 exact match comparison.
 */
export function normalizeTitleForExactMatch(title) {
    return String(title || '')
        .toLowerCase()
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/[^\p{L}\p{N}\s._/-]/gu, '')
        .replace(/\s+/g, ' ')
        .trim();
}
/**
 * Tokenize text into lowercase alphanumeric/identifier tokens, filtering stopwords.
 */
export function tokenizeForDedup(text) {
    const raw = String(text || '')
        .toLowerCase()
        .split(/[^a-z0-9_./-]+/g);
    const tokens = [];
    for (const part of raw) {
        const cleaned = part.replace(/^[._/-]+|[._/-]+$/g, '');
        if (cleaned.length < 2)
            continue;
        if (STOPWORDS.has(cleaned))
            continue;
        tokens.push(cleaned);
    }
    return tokens;
}
/**
 * Build a corpus-wide Inverse Document Frequency (IDF) map from existing observations:
 *   idf(t) = ln((N + 1) / (df(t) + 1)) + 1
 */
export function buildCorpusIdfMap(documents) {
    const docCount = Math.max(1, documents.length);
    const df = new Map();
    for (const doc of documents) {
        const uniqueTokens = new Set(tokenizeForDedup(`${doc.title} ${doc.narrative}`));
        for (const token of uniqueTokens) {
            df.set(token, (df.get(token) ?? 0) + 1);
        }
    }
    const idf = new Map();
    for (const [token, count] of df.entries()) {
        idf.set(token, Math.log((docCount + 1) / (count + 1)) + 1);
    }
    return idf;
}
function defaultIdfWeight(corpusSize, idfMap, token) {
    const known = idfMap.get(token);
    if (known !== undefined)
        return known;
    // Unseen token has df = 0 -> maximum rarity in the corpus
    return Math.log(Math.max(1, corpusSize) + 1) + 1;
}
/**
 * Compute IDF-weighted cosine similarity and shared unique token count between two token lists.
 */
export function tfidfCosineSimilarity(tokensA, tokensB, idfMap, corpusSize = 10) {
    if (tokensA.length === 0 || tokensB.length === 0) {
        return { similarity: 0, sharedTokens: 0 };
    }
    const tfA = new Map();
    const tfB = new Map();
    for (const t of tokensA)
        tfA.set(t, (tfA.get(t) ?? 0) + 1);
    for (const t of tokensB)
        tfB.set(t, (tfB.get(t) ?? 0) + 1);
    let dot = 0;
    let normA = 0;
    let normB = 0;
    let sharedTokens = 0;
    for (const [token, countA] of tfA.entries()) {
        const tfWeightA = 1 + Math.log(countA);
        const wA = tfWeightA * defaultIdfWeight(corpusSize, idfMap, token);
        normA += wA * wA;
        const countB = tfB.get(token);
        if (countB !== undefined) {
            sharedTokens += 1;
            const tfWeightB = 1 + Math.log(countB);
            const wB = tfWeightB * defaultIdfWeight(corpusSize, idfMap, token);
            dot += wA * wB;
        }
    }
    for (const [token, countB] of tfB.entries()) {
        const tfWeightB = 1 + Math.log(countB);
        const wB = tfWeightB * defaultIdfWeight(corpusSize, idfMap, token);
        normB += wB * wB;
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    if (denom <= 0)
        return { similarity: 0, sharedTokens };
    return { similarity: dot / denom, sharedTokens };
}
/**
 * Rare-token IDF Veto:
 * If the symmetric difference between A and B contains a high-IDF discriminating token
 * (such as a specific file path, identifier, or distinct error code whose IDF is >=
 * `idfVetoRatio * maxPossibleIdf`, or a structural path/identifier difference),
 * veto the merge so two distinct fixes are not collapsed into one.
 */
export function shouldIdfVeto(tokensA, tokensB, idfMap, corpusSize = 10, idfVetoRatio = DEFAULT_IDF_VETO_RATIO) {
    const setA = new Set(tokensA);
    const setB = new Set(tokensB);
    const maxIdf = Math.log(Math.max(2, corpusSize) + 1) + 1;
    const threshold = maxIdf * idfVetoRatio;
    const symmetricDiff = [];
    for (const t of setA) {
        if (!setB.has(t))
            symmetricDiff.push(t);
    }
    for (const t of setB) {
        if (!setA.has(t))
            symmetricDiff.push(t);
    }
    for (const diffToken of symmetricDiff) {
        // Structural file path or dotted/slashed symbol in symmetric difference is a strong discriminator
        if ((diffToken.includes('/') || diffToken.includes('.')) && diffToken.length >= 4) {
            return true;
        }
        if (corpusSize >= 3) {
            const tokenIdf = defaultIdfWeight(corpusSize, idfMap, diffToken);
            if (tokenIdf >= threshold && diffToken.length >= 4) {
                return true;
            }
        }
    }
    return false;
}
/**
 * Decide whether observation `a` and `b` are exact duplicates, near-duplicate candidates, or distinct.
 */
export function decideNearDuplicate(a, b, idfMap, corpusSize = 10, config = {}) {
    const similarityThreshold = config.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
    const minSharedTokens = config.minSharedTokens ?? DEFAULT_MIN_SHARED_TOKENS;
    const idfVetoRatio = config.idfVetoRatio ?? DEFAULT_IDF_VETO_RATIO;
    const normA = normalizeTitleForExactMatch(a.title);
    const normB = normalizeTitleForExactMatch(b.title);
    if (normA.length > 0 && normA === normB) {
        return { tier: 'exact', similarity: 1 };
    }
    const tokensA = tokenizeForDedup(`${a.title} ${a.narrative}`);
    const tokensB = tokenizeForDedup(`${b.title} ${b.narrative}`);
    const { similarity, sharedTokens } = tfidfCosineSimilarity(tokensA, tokensB, idfMap, corpusSize);
    if (sharedTokens < minSharedTokens) {
        return { tier: 'distinct', similarity };
    }
    if (shouldIdfVeto(tokensA, tokensB, idfMap, corpusSize, idfVetoRatio)) {
        return { tier: 'distinct', similarity, vetoed: true };
    }
    if (similarity < similarityThreshold) {
        return { tier: 'distinct', similarity };
    }
    return { tier: 'candidate', similarity };
}
