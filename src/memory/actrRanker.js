/**
 * @file src/memory/actrRanker.ts
 * ACT-R Cognitive Base-Level Activation Ranking for Causyne Episodic Memory.
 *
 * Ranks observations using Anderson's ACT-R power-law decay and reinforcement formula:
 *   score = ln(1 + t_created^(-d) + alpha * sum(t_reinforce^(-d)))
 *
 * Preserves a recency head of `ceil(count / 4)` so brand-new observations remain
 * at the top of the context while repeatedly reinforced architectural decisions
 * and bugfixes from older sessions climb into the active budget.
 *
 * Authorship: Strict TypeScript (Causyne Agent).
 */
const DEFAULT_DECAY = 0.5;
const DEFAULT_ALPHA = 0.5;
const DEFAULT_TIME_UNIT_MS = 3_600_000;
const DEFAULT_MIN_TIME_UNITS = 0.05;
/**
 * Compute the ACT-R base-level activation strength for an observation.
 */
export function computeObservationStrength(createdAtEpochMs, reinforcedAtEpochsMs, nowMs = Date.now(), config = {}) {
    const decay = config.decay ?? DEFAULT_DECAY;
    const alpha = config.reinforcementAlpha ?? DEFAULT_ALPHA;
    const timeUnitMs = config.timeUnitMs ?? DEFAULT_TIME_UNIT_MS;
    const minUnits = config.minTimeUnits ?? DEFAULT_MIN_TIME_UNITS;
    const ageUnits = Math.max(minUnits, (nowMs - createdAtEpochMs) / timeUnitMs);
    let sumPower = Math.pow(ageUnits, -decay);
    for (const rEpoch of reinforcedAtEpochsMs) {
        if (!Number.isFinite(rEpoch))
            continue;
        const rAgeUnits = Math.max(minUnits, (nowMs - rEpoch) / timeUnitMs);
        sumPower += alpha * Math.pow(rAgeUnits, -decay);
    }
    return Math.log(1 + sumPower);
}
/**
 * Rank a candidate pool of observations (expected in DESC created_at_epoch order,
 * or sorted internally) down to `count` items using ACT-R strength with recency head.
 *
 * The newest `ceil(count / 4)` items are pinned as the recency head so immediate
 * session continuity is never displaced. The remaining `count - headCount` slots
 * are filled from the rest of the pool ranked by ACT-R activation score (ties broken
 * by newer createdAtEpochMs).
 */
export function rankObservationsByStrength(pool, count, nowMs = Date.now(), config = {}) {
    if (count <= 0 || pool.length === 0)
        return [];
    const sortedByRecency = [...pool].sort((a, b) => {
        if (b.createdAtEpochMs !== a.createdAtEpochMs) {
            return b.createdAtEpochMs - a.createdAtEpochMs;
        }
        return b.id - a.id;
    });
    if (sortedByRecency.length <= count) {
        return sortedByRecency;
    }
    const headCount = Math.min(sortedByRecency.length, Math.ceil(count / 4));
    const head = sortedByRecency.slice(0, headCount);
    const tailBudget = Math.max(0, count - head.length);
    if (tailBudget === 0) {
        return head;
    }
    const tailCandidates = sortedByRecency.slice(headCount);
    const scored = tailCandidates.map((obs) => ({
        obs,
        score: computeObservationStrength(obs.createdAtEpochMs, obs.reinforcedAtEpochsMs, nowMs, config)
    }));
    scored.sort((a, b) => {
        if (b.score !== a.score)
            return b.score - a.score;
        if (b.obs.createdAtEpochMs !== a.obs.createdAtEpochMs) {
            return b.obs.createdAtEpochMs - a.obs.createdAtEpochMs;
        }
        return b.obs.id - a.obs.id;
    });
    const selectedTail = scored.slice(0, tailBudget).map((item) => item.obs);
    return [...head, ...selectedTail];
}
