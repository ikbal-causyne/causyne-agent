import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TelemetryCollector } from '../src/infra/telemetry.js';

describe('telemetry', () => {
  it('records turn metrics and computes summary accurately', () => {
    const collector = new TelemetryCollector();
    collector.recordTurn({
      sessionId: 'sess_1',
      taskId: 'task_1',
      turnIndex: 0,
      provider: 'antigravity',
      model: 'gemini-3.8-flash-high',
      promptTokens: 1000,
      completionTokens: 200,
      cachedPromptTokens: 500,
      noncachedTokens: 700,
      durationMs: 1500,
      planCacheHit: true,
      toolOutputTruncatedCount: 0,
      historyCompactedChars: 400
    });

    collector.recordTurn({
      sessionId: 'sess_1',
      taskId: 'task_1',
      turnIndex: 1,
      provider: 'antigravity',
      model: 'gemini-3.8-flash-high',
      promptTokens: 2000,
      completionTokens: 300,
      cachedPromptTokens: 1000,
      noncachedTokens: 1300,
      durationMs: 2500,
      planCacheHit: false,
      toolOutputTruncatedCount: 1,
      historyCompactedChars: 800
    });

    const records = collector.getRecordsForTask('task_1');
    assert.equal(records.length, 2);

    const summary = collector.getSummary('task_1');
    assert.equal(summary.totalPromptTokens, 3000);
    assert.equal(summary.totalCompletionTokens, 500);
    assert.equal(summary.totalCachedPromptTokens, 1500);
    assert.equal(summary.totalNoncachedTokens, 2000);
    assert.equal(summary.totalDurationMs, 4000);
    assert.equal(summary.turnCount, 2);
  });
});
