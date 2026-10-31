export function noncachedTokens(usage) {
    const finite = (value) => Number.isFinite(value) ? Math.max(0, value ?? 0) : 0;
    const input = usage.uncachedPromptTokens !== undefined
        ? finite(usage.uncachedPromptTokens)
        // Cache reads larger than input prove these are separate peer counters.
        // Do not erase fresh input by subtracting that counter again.
        : finite(usage.cachedPromptTokens) > finite(usage.promptTokens)
            ? finite(usage.promptTokens)
            : Math.max(0, finite(usage.promptTokens) - finite(usage.cachedPromptTokens));
    return input + finite(usage.completionTokens);
}
export function actionLimitFor(archetype) {
    if (archetype === 'desktop_personalization')
        return 12;
    if (archetype === 'media_3d_generation')
        return 25;
    if (archetype === 'game_development' || archetype === 'game')
        return 250;
    if (archetype === 'software_engineering' || archetype === 'backend_engineering')
        return 200;
    if (archetype === 'web_engineering')
        return 120;
    return 35;
}
export function tokenLimitFor(archetype) {
    if (archetype === 'desktop_personalization')
        return 150_000;
    if (archetype === 'game_development' || archetype === 'game')
        return 3_000_000;
    if (archetype === 'software_engineering' || archetype === 'backend_engineering')
        return 2_500_000;
    if (archetype === 'media_3d_generation')
        return 400_000;
    if (archetype === 'web_engineering' || archetype === 'web_fullstack')
        return 500_000;
    return 100_000;
}
export function turnTokenLimitFor(archetype) {
    if (archetype === 'game_development' || archetype === 'game')
        return 1_000_000;
    if (archetype === 'software_engineering' || archetype === 'backend_engineering')
        return 1_000_000;
    if (archetype === 'web_engineering' || archetype === 'web_fullstack')
        return 250_000;
    if (archetype === 'media_3d_generation')
        return 200_000;
    if (archetype === 'desktop_personalization')
        return 100_000;
    return 100_000;
}
export class EfficiencyCheckpoint extends Error {
    code = 'CAUSYNE_EFFICIENCY_CHECKPOINT';
    reason;
    used;
    limit;
    scope;
    constructor(reason, used, limit, scope = 'task') {
        const scopeLabel = scope === 'turn' ? 'single-turn' : 'task';
        const guidance = scope === 'turn'
            ? 'Auto-compacting context and continuing task execution.'
            : 'Session history is retained; continue from this checkpoint without repeating completed actions.';
        super(`Efficiency checkpoint: ${used.toLocaleString()} ${reason} reached the ${limit.toLocaleString()} ${scopeLabel} limit. ${guidance}`);
        this.name = 'EfficiencyCheckpoint';
        this.reason = reason;
        this.used = used;
        this.limit = limit;
        this.scope = scope;
    }
}
export class UnifiedBudgetEnforcer {
    maxTurnTokens;
    maxTurnActions;
    maxTaskTokens;
    tokens = 0;
    actions = 0;
    nativeIds = new Set();
    constructor(maxTurnTokens = 100_000, maxTurnActions = 35, maxTaskTokens) {
        if (!Number.isFinite(maxTurnTokens) || maxTurnTokens <= 0
            || !Number.isSafeInteger(maxTurnActions) || maxTurnActions <= 0) {
            throw new Error('Invalid efficiency limits');
        }
        this.maxTurnTokens = maxTurnTokens;
        this.maxTurnActions = maxTurnActions;
        this.maxTaskTokens = typeof maxTaskTokens === 'number' && Number.isFinite(maxTaskTokens) && maxTaskTokens > 0
            ? Math.max(maxTaskTokens, maxTurnTokens)
            : maxTurnTokens;
    }
    extendBudget(extraTokens, extraActions) {
        this.maxTaskTokens = Math.max(this.maxTaskTokens, this.tokens + extraTokens);
        this.maxTurnTokens = Math.max(this.maxTurnTokens, extraTokens);
        this.maxTurnActions = Math.max(this.maxTurnActions, this.actions + extraActions);
    }
    recordUsage(usage) {
        const fresh = noncachedTokens(usage);
        if (fresh >= this.maxTurnTokens) {
            throw new EfficiencyCheckpoint('tokens', fresh, this.maxTurnTokens, 'turn');
        }
        this.tokens += fresh;
        if (this.tokens >= this.maxTaskTokens) {
            throw new EfficiencyCheckpoint('tokens', this.tokens, this.maxTaskTokens, 'task');
        }
    }
    recordAction(nativeId) {
        if (nativeId && this.nativeIds.has(nativeId))
            return;
        if (this.actions >= this.maxTurnActions) {
            throw new EfficiencyCheckpoint('actions', this.actions, this.maxTurnActions, 'task');
        }
        if (nativeId)
            this.nativeIds.add(nativeId);
        this.actions++;
    }
    getRemainingTokens() {
        return Math.max(0, this.maxTaskTokens - this.tokens);
    }
    getRemainingTurnTokens() {
        return this.maxTurnTokens;
    }
    getRemainingActions() {
        return Math.max(0, this.maxTurnActions - this.actions);
    }
    snapshot() {
        return {
            noncachedTokens: this.tokens,
            actions: this.actions,
            tokenLimit: this.maxTurnTokens,
            taskTokenLimit: this.maxTaskTokens,
            actionLimit: this.maxTurnActions
        };
    }
}
