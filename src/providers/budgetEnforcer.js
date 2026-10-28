export function noncachedTokens(usage) {
    const finite = (value) => Number.isFinite(value) ? Math.max(0, value ?? 0) : 0;
    const input = usage.uncachedPromptTokens !== undefined
        ? finite(usage.uncachedPromptTokens)
        : Math.max(0, finite(usage.promptTokens) - Math.min(finite(usage.promptTokens), finite(usage.cachedPromptTokens)));
    return input + finite(usage.completionTokens);
}
export function actionLimitFor(archetype) {
    if (archetype === 'desktop_personalization')
        return 12;
    if (archetype === 'media_3d_generation')
        return 25;
    return 35;
}
export class EfficiencyCheckpoint extends Error {
    code = 'CAUSYNE_EFFICIENCY_CHECKPOINT';
    reason;
    used;
    limit;
    constructor(reason, used, limit) {
        super(`Efficiency checkpoint: ${used.toLocaleString()} ${reason} reached the ${limit.toLocaleString()} turn limit. `
            + 'Work is unfinished. Session history is retained; continue from this checkpoint without repeating completed actions.');
        this.name = 'EfficiencyCheckpoint';
        this.reason = reason;
        this.used = used;
        this.limit = limit;
    }
}
export class UnifiedBudgetEnforcer {
    maxTurnTokens;
    maxTurnActions;
    tokens = 0;
    actions = 0;
    nativeIds = new Set();
    constructor(maxTurnTokens = 100_000, maxTurnActions = 35) {
        if (!Number.isFinite(maxTurnTokens) || maxTurnTokens <= 0
            || !Number.isSafeInteger(maxTurnActions) || maxTurnActions <= 0) {
            throw new Error('Invalid efficiency limits');
        }
        this.maxTurnTokens = maxTurnTokens;
        this.maxTurnActions = maxTurnActions;
    }
    recordUsage(usage) {
        this.tokens += noncachedTokens(usage);
        if (this.tokens >= this.maxTurnTokens) {
            throw new EfficiencyCheckpoint('tokens', this.tokens, this.maxTurnTokens);
        }
    }
    recordAction(nativeId) {
        if (nativeId && this.nativeIds.has(nativeId))
            return;
        if (this.actions >= this.maxTurnActions) {
            throw new EfficiencyCheckpoint('actions', this.actions, this.maxTurnActions);
        }
        if (nativeId)
            this.nativeIds.add(nativeId);
        this.actions++;
    }
    getRemainingTokens() {
        return Math.max(0, this.maxTurnTokens - this.tokens);
    }
    getRemainingActions() {
        return Math.max(0, this.maxTurnActions - this.actions);
    }
    snapshot() {
        return {
            noncachedTokens: this.tokens,
            actions: this.actions,
            tokenLimit: this.maxTurnTokens,
            actionLimit: this.maxTurnActions
        };
    }
}
