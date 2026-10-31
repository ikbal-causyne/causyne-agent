/**
 * @file src/session/cachePressure.ts
 * Causyne Agent — Process Cache Pressure Monitor & Cold Session Eviction
 *
 * Adapted from Hermes Agent (gateway/agent_cache_pressure.py) and OpenCode session management.
 * Monitors process RSS against memory thresholds and evicts cold sessions from memory
 * while strictly protecting the most recent warm sessions to preserve KV prompt cache value.
 *
 * Authorship: Strict TypeScript (Causyne Agent).
 */

import * as os from 'node:os';

export interface CachePressureConfig {
  /** Fraction of available system/cgroup memory to treat as threshold (default: 0.65). */
  autoBudgetFraction: number;
  /** Minimum memory floor in MB before pressure triggers (default: 512 MB). */
  autoBudgetFloorMb: number;
  /** Maximum number of sessions to evict in a single pass (default: 16). */
  maxEvictionsPerPass: number;
  /** Number of most-recently-active sessions to protect from eviction (default: 8). */
  protectRecent: number;
}

export interface SessionMemoryRecord {
  id: string;
  lastActiveAt: number;
  estimatedBytes: number;
  isPinned?: boolean;
}

export interface EvictionResult {
  underPressure: boolean;
  rssMb: number;
  thresholdMb: number;
  evictedSessionIds: string[];
  reclaimedBytes: number;
}

export class SessionCachePressure {
  private config: CachePressureConfig;

  constructor(customConfig?: Partial<CachePressureConfig>) {
    this.config = {
      autoBudgetFraction: customConfig?.autoBudgetFraction ?? 0.65,
      autoBudgetFloorMb: customConfig?.autoBudgetFloorMb ?? 512,
      maxEvictionsPerPass: customConfig?.maxEvictionsPerPass ?? 16,
      protectRecent: customConfig?.protectRecent ?? 8,
    };
  }

  public getConfig(): Readonly<CachePressureConfig> {
    return { ...this.config };
  }

  public getProcessMemoryUsageMb(): number {
    const memory = process.memoryUsage();
    return Math.round(memory.rss / (1024 * 1024));
  }

  public calculateThresholdMb(totalSystemMemoryMb?: number): number {
    const totalMb = totalSystemMemoryMb ?? Math.round(os.totalmem() / (1024 * 1024));
    const calculatedBudget = Math.round(totalMb * this.config.autoBudgetFraction);
    return Math.max(this.config.autoBudgetFloorMb, calculatedBudget);
  }

  public isUnderPressure(totalSystemMemoryMb?: number): boolean {
    const rssMb = this.getProcessMemoryUsageMb();
    const thresholdMb = this.calculateThresholdMb(totalSystemMemoryMb);
    return rssMb > thresholdMb;
  }

  /**
   * Evaluates memory pressure and identifies cold sessions to evict.
   * Protects the hottest `protectRecent` sessions and pinned sessions.
   */
  public evaluateEvictions(
    sessions: SessionMemoryRecord[],
    forceCheck = false,
    mockRssMb?: number
  ): EvictionResult {
    const rssMb = mockRssMb ?? this.getProcessMemoryUsageMb();
    const thresholdMb = this.calculateThresholdMb();
    const underPressure = forceCheck || rssMb > thresholdMb;

    if (!underPressure || sessions.length <= this.config.protectRecent) {
      return {
        underPressure,
        rssMb,
        thresholdMb,
        evictedSessionIds: [],
        reclaimedBytes: 0,
      };
    }

    // Sort descending by lastActiveAt (hottest first)
    const sorted = [...sessions].sort((a, b) => b.lastActiveAt - a.lastActiveAt);

    // Protect the top `protectRecent` warm sessions
    const protectedIds = new Set(sorted.slice(0, this.config.protectRecent).map(s => s.id));

    // Candidates for eviction: oldest first (excluding protected and pinned)
    const candidates = sorted
      .slice(this.config.protectRecent)
      .filter(s => !s.isPinned && !protectedIds.has(s.id))
      .reverse(); // Oldest first

    const toEvict = candidates.slice(0, this.config.maxEvictionsPerPass);
    const evictedSessionIds = toEvict.map(s => s.id);
    const reclaimedBytes = toEvict.reduce((sum, s) => sum + s.estimatedBytes, 0);

    return {
      underPressure,
      rssMb,
      thresholdMb,
      evictedSessionIds,
      reclaimedBytes,
    };
  }
}

export const defaultCachePressure = new SessionCachePressure();
