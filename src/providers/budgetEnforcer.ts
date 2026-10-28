/** Shared turn accounting for direct providers and agent peers. */
export interface BudgetUsage {
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens?: number | undefined;
  uncachedPromptTokens?: number | undefined;
  measurement?: string | undefined;
}

export function noncachedTokens(usage: BudgetUsage): number {
  const finite = (value: number | undefined): number => Number.isFinite(value) ? Math.max(0, value ?? 0) : 0;
  const input = usage.uncachedPromptTokens !== undefined
    ? finite(usage.uncachedPromptTokens)
    // Cache reads larger than input prove these are separate peer counters.
    // Do not erase fresh input by subtracting that counter again.
    : finite(usage.cachedPromptTokens) > finite(usage.promptTokens)
      ? finite(usage.promptTokens)
      : Math.max(0, finite(usage.promptTokens) - finite(usage.cachedPromptTokens));
  return input + finite(usage.completionTokens);
}

export function actionLimitFor(archetype: string): number {
  if (archetype === 'desktop_personalization') return 12;
  if (archetype === 'media_3d_generation') return 25;
  return 35;
}

export function tokenLimitFor(archetype: string): number {
  if (archetype === 'desktop_personalization') return 150_000;
  if (archetype === 'media_3d_generation') return 400_000;
  if (archetype === 'web_engineering' || archetype === 'web_fullstack') return 500_000;
  return 100_000;
}

export class EfficiencyCheckpoint extends Error {
  readonly code = 'CAUSYNE_EFFICIENCY_CHECKPOINT';
  readonly reason: 'tokens' | 'actions';
  readonly used: number;
  readonly limit: number;
  readonly scope: 'turn' | 'task';

  constructor(reason: 'tokens' | 'actions', used: number, limit: number, scope: 'turn' | 'task' = 'task') {
    const scopeLabel = scope === 'turn' ? 'single-turn' : 'task';
    super(`Efficiency checkpoint: ${used.toLocaleString()} ${reason} reached the ${limit.toLocaleString()} ${scopeLabel} limit. `
      + 'Work is unfinished. Session history is retained; continue from this checkpoint without repeating completed actions.');
    this.name = 'EfficiencyCheckpoint';
    this.reason = reason;
    this.used = used;
    this.limit = limit;
    this.scope = scope;
  }
}

export class UnifiedBudgetEnforcer {
  readonly maxTurnTokens: number;
  readonly maxTurnActions: number;
  readonly maxTaskTokens: number;
  private tokens = 0;
  private actions = 0;
  private readonly nativeIds = new Set<string>();

  constructor(maxTurnTokens = 100_000, maxTurnActions = 35, maxTaskTokens?: number) {
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

  recordUsage(usage: BudgetUsage): void {
    const fresh = noncachedTokens(usage);
    if (fresh >= this.maxTurnTokens) {
      throw new EfficiencyCheckpoint('tokens', fresh, this.maxTurnTokens, 'turn');
    }
    this.tokens += fresh;
    if (this.tokens >= this.maxTaskTokens) {
      throw new EfficiencyCheckpoint('tokens', this.tokens, this.maxTaskTokens, 'task');
    }
  }

  recordAction(nativeId?: string): void {
    if (nativeId && this.nativeIds.has(nativeId)) return;
    if (this.actions >= this.maxTurnActions) {
      throw new EfficiencyCheckpoint('actions', this.actions, this.maxTurnActions, 'task');
    }
    if (nativeId) this.nativeIds.add(nativeId);
    this.actions++;
  }

  getRemainingTokens(): number {
    return Math.max(0, this.maxTaskTokens - this.tokens);
  }

  getRemainingTurnTokens(): number {
    return this.maxTurnTokens;
  }

  getRemainingActions(): number {
    return Math.max(0, this.maxTurnActions - this.actions);
  }

  snapshot(): { noncachedTokens: number; actions: number; tokenLimit: number; taskTokenLimit: number; actionLimit: number } {
    return {
      noncachedTokens: this.tokens,
      actions: this.actions,
      tokenLimit: this.maxTurnTokens,
      taskTokenLimit: this.maxTaskTokens,
      actionLimit: this.maxTurnActions
    };
  }
}
