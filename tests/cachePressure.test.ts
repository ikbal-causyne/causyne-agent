import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionCachePressure, type SessionMemoryRecord } from '../src/session/cachePressure.js';

test('SessionCachePressure initializes with default config values', () => {
  const pressure = new SessionCachePressure();
  const config = pressure.getConfig();
  assert.equal(config.autoBudgetFraction, 0.65);
  assert.equal(config.autoBudgetFloorMb, 512);
  assert.equal(config.maxEvictionsPerPass, 16);
  assert.equal(config.protectRecent, 8);
});

test('SessionCachePressure calculates threshold respecting memory floor', () => {
  const pressure = new SessionCachePressure({
    autoBudgetFraction: 0.5,
    autoBudgetFloorMb: 512
  });

  // For a tiny 500 MB system, floor of 512 MB must win
  assert.equal(pressure.calculateThresholdMb(500), 512);

  // For a 4096 MB system, 50% = 2048 MB must win
  assert.equal(pressure.calculateThresholdMb(4096), 2048);
});

test('SessionCachePressure reports process memory in reasonable range', () => {
  const pressure = new SessionCachePressure();
  const rssMb = pressure.getProcessMemoryUsageMb();
  assert.ok(typeof rssMb === 'number');
  assert.ok(rssMb > 0);
  assert.ok(rssMb < 100_000); // Sanity check < 100GB
});

test('SessionCachePressure evaluateEvictions protects hottest sessions', () => {
  const pressure = new SessionCachePressure({
    protectRecent: 3,
    maxEvictionsPerPass: 5
  });

  const now = Date.now();
  const sessions: SessionMemoryRecord[] = [
    { id: 'sess_1', lastActiveAt: now - 1000, estimatedBytes: 10_000 },
    { id: 'sess_2', lastActiveAt: now - 2000, estimatedBytes: 20_000 },
    { id: 'sess_3', lastActiveAt: now - 3000, estimatedBytes: 30_000 },
    { id: 'sess_4', lastActiveAt: now - 4000, estimatedBytes: 40_000 },
    { id: 'sess_5', lastActiveAt: now - 5000, estimatedBytes: 50_000 },
    { id: 'sess_6', lastActiveAt: now - 6000, estimatedBytes: 60_000 },
  ];

  // Force check with mock RSS exceeding threshold
  const result = pressure.evaluateEvictions(sessions, true, 2048);

  assert.equal(result.underPressure, true);
  // sess_1, sess_2, sess_3 are the 3 most recent, so they must be protected
  assert.ok(!result.evictedSessionIds.includes('sess_1'));
  assert.ok(!result.evictedSessionIds.includes('sess_2'));
  assert.ok(!result.evictedSessionIds.includes('sess_3'));

  // Remaining sessions should be evicted, oldest first
  assert.deepEqual(result.evictedSessionIds, ['sess_6', 'sess_5', 'sess_4']);
  assert.equal(result.reclaimedBytes, 150_000);
});

test('SessionCachePressure evaluateEvictions respects isPinned flag', () => {
  const pressure = new SessionCachePressure({
    protectRecent: 1,
    maxEvictionsPerPass: 5
  });

  const now = Date.now();
  const sessions: SessionMemoryRecord[] = [
    { id: 'sess_hottest', lastActiveAt: now, estimatedBytes: 1000 },
    { id: 'sess_pinned_old', lastActiveAt: now - 99999, estimatedBytes: 5000, isPinned: true },
    { id: 'sess_cold', lastActiveAt: now - 50000, estimatedBytes: 2000 },
  ];

  const result = pressure.evaluateEvictions(sessions, true, 2048);
  assert.ok(!result.evictedSessionIds.includes('sess_hottest'));
  assert.ok(!result.evictedSessionIds.includes('sess_pinned_old'));
  assert.deepEqual(result.evictedSessionIds, ['sess_cold']);
  assert.equal(result.reclaimedBytes, 2000);
});

test('SessionCachePressure evaluateEvictions caps at maxEvictionsPerPass', () => {
  const pressure = new SessionCachePressure({
    protectRecent: 1,
    maxEvictionsPerPass: 2
  });

  const now = Date.now();
  const sessions: SessionMemoryRecord[] = [
    { id: 'sess_recent', lastActiveAt: now, estimatedBytes: 100 },
    { id: 'sess_cold_1', lastActiveAt: now - 1000, estimatedBytes: 100 },
    { id: 'sess_cold_2', lastActiveAt: now - 2000, estimatedBytes: 100 },
    { id: 'sess_cold_3', lastActiveAt: now - 3000, estimatedBytes: 100 },
    { id: 'sess_cold_4', lastActiveAt: now - 4000, estimatedBytes: 100 },
  ];

  const result = pressure.evaluateEvictions(sessions, true, 2048);
  assert.equal(result.evictedSessionIds.length, 2);
  assert.deepEqual(result.evictedSessionIds, ['sess_cold_4', 'sess_cold_3']);
});
