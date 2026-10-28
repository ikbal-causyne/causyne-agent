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
    : Math.max(0, finite(usage.promptTokens) - Math.min(finite(usage.promptTokens), finite(usage.cachedPromptTokens)));
  return input + finite(usage.completionTokens);
}

export function actionLimitFor(archetype: string): number {
  if (archetype === 'desktop_personalization') return 12;
  if (archetype === 'media_3d_generation') return 25;
  return 35;
}

export class EfficiencyCheckpoint extends Error {
  readonly code = 'CAUSYNE_EFFICIENCY_CHECKPOINT';
  readonly reason: 'tokens' | 'actions';
  readonly used: number;
  readonly limit: number;

  constructor(reason: 'tokens' | 'actions', used: number, limit: number) {
    super(`Efficiency checkpoint: ${used.toLocaleString()} ${reason} reached the ${limit.toLocaleString()} turn limit. `
      + 'Work is unfinished. Session history is retained; continue from this checkpoint without repeating completed actions.');
    this.name = 'EfficiencyCheckpoint';
    this.reason = reason;
    this.used = used;
    this.limit = limit;
  }
}

export class UnifiedBudgetEnforcer {
  readonly maxTurnTokens: number;
  readonly maxTurnActions: number;
  private tokens = 0;
  private actions = 0;
  private readonly nativeIds = new Set<string>();

  constructor(maxTurnTokens = 100_000, maxTurnActions = 35) {
    if (!Number.isFinite(maxTurnTokens) || maxTurnTokens <= 0
      || !Number.isSafeInteger(maxTurnActions) || maxTurnActions <= 0) {
      throw new Error('Invalid efficiency limits');
    }
    this.maxTurnTokens = maxTurnTokens;
    this.maxTurnActions = maxTurnActions;
  }

  recordUsage(usage: BudgetUsage): void {
    this.tokens += noncachedTokens(usage);
    if (this.tokens >= this.maxTurnTokens) {
      throw new EfficiencyCheckpoint('tokens', this.tokens, this.maxTurnTokens);
    }
  }

  recordAction(nativeId?: string): void {
    if (nativeId && this.nativeIds.has(nativeId)) return;
    if (this.actions >= this.maxTurnActions) {
      throw new EfficiencyCheckpoint('actions', this.actions, this.maxTurnActions);
    }
    if (nativeId) this.nativeIds.add(nativeId);
    this.actions++;
  }

  getRemainingTokens(): number {
    return Math.max(0, this.maxTurnTokens - this.tokens);
  }

  getRemainingActions(): number {
    return Math.max(0, this.maxTurnActions - this.actions);
  }

  snapshot(): { noncachedTokens: number; actions: number; tokenLimit: number; actionLimit: number } {
    return {
      noncachedTokens: this.tokens,
      actions: this.actions,
      tokenLimit: this.maxTurnTokens,
      actionLimit: this.maxTurnActions
    };
  }
}
