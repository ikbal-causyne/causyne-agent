/**
 * @file src/infra/telemetry.ts
 * Causyne Agent — Structured OpenTelemetry-Compatible Turn Telemetry
 *
 * Tracks fine-grained per-turn token metrics, cache hits, tool latency, and
 * memory compaction savings for real-time performance auditing.
 *
 * Authorship: Strict TypeScript (Causyne Agent).
 */
export class TelemetryCollector {
    records = [];
    recordTurn(record) {
        const fullRecord = {
            ...record,
            timestamp: Date.now()
        };
        this.records.push(fullRecord);
        return fullRecord;
    }
    getRecordsForTask(taskId) {
        return this.records.filter(r => r.taskId === taskId);
    }
    getSummary(taskId) {
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
    clear() {
        this.records = [];
    }
}
export const defaultTelemetry = new TelemetryCollector();
