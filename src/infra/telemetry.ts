/**
 * @file src/infra/telemetry.ts
 * Causyne Agent — Structured OpenTelemetry-Compatible Turn Telemetry
 *
 * Tracks fine-grained per-turn token metrics, cache hits, tool latency, and
 * memory compaction savings for real-time performance auditing.
 *
 * Authorship: Strict TypeScript (Causyne Agent).
 */

export interface TurnTelemetryRecord {
  sessionId: string;
  taskId: string;
  turnIndex: number;
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  cachedPromptTokens: number;
  noncachedTokens: number;
  durationMs: number;
  planCacheHit: boolean;
  toolOutputTruncatedCount: number;
  historyCompactedChars: number;
  timestamp: number;
}

export class TelemetryCollector {
  private records: TurnTelemetryRecord[] = [];

  public recordTurn(record: Omit<TurnTelemetryRecord, 'timestamp'>): TurnTelemetryRecord {
    const fullRecord: TurnTelemetryRecord = {
      ...record,
      timestamp: Date.now()
    };
    this.records.push(fullRecord);
    return fullRecord;
  }

  public getRecordsForTask(taskId: string): readonly TurnTelemetryRecord[] {
    return this.records.filter(r => r.taskId === taskId);
  }

  public getSummary(taskId?: string): {
    totalPromptTokens: number;
    totalCompletionTokens: number;
    totalCachedPromptTokens: number;
    totalNoncachedTokens: number;
    totalDurationMs: number;
    turnCount: number;
  } {
    const active = taskId ? this.getRecordsForTask(taskId) : this.records;
    return {
      totalPromptTokens: active.reduce((sum, r) => sum + r.promptTokens, 0),
      totalCompletionTokens: active.reduce((sum, r) => sum + r.completionTokens, 0),
      totalCachedPromptTokens: active.reduce((sum, r) => sum + r.cachedPromptTokens, 0),
      totalNoncachedTokens: active.reduce((sum, r) => sum + r.noncachedTokens, 0),
      totalDurationMs: active.reduce((sum, r) => sum + r.durationMs, 0),
      turnCount: active.length
    };
  }

  public clear(): void {
    this.records = [];
  }
}

export const defaultTelemetry = new TelemetryCollector();
