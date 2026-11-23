import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AuditLog, computeAuditEntryHash, formatAuditExport } from '../src/auditLog.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-wave4-'));

after(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
});

describe('Wave 4 — Enterprise Governance, Audit, Hooks, Sessions & Checkpoints', () => {
  test('AuditLog writes tamper-evident SHA-256 hash chain, verifies integrity, detects tampering, exports OCSF, and prunes old logs', () => {
    const prevHome = process.env.CAUSYNE_HOME;
    const auditHome = path.join(TMP, 'audit-home');
    fs.mkdirSync(auditHome, { recursive: true });
    process.env.CAUSYNE_HOME = auditHome;

    try {
      const log = new AuditLog();
      log.setContext({ actor: 'ci-bot', sessionId: 'sess-42', provider: 'ollama' });
      log.log({ event: 'tool_executed', tool: 'fs_read', taskId: 't-1', risk: 'low' });
      log.log({ event: 'tool_blocked', tool: 'sysRun', taskId: 't-1', risk: 'high', reason: 'blocked with sk-ant-api03-123456789012345678901234567890' });

      const recent = log.getRecentLogs(10);
      assert.equal(recent.length, 2);
      assert.equal(recent[0]!.prevHash, 'GENESIS');
      assert.match(String(recent[0]!.entryHash), /^[a-f0-9]{64}$/);
      assert.equal(recent[1]!.prevHash, recent[0]!.entryHash);
      assert.equal(recent[1]!.actor, 'ci-bot');
      assert.equal(recent[1]!.sessionId, 'sess-42');
      assert.equal(
        recent[1]!.entryHash,
        computeAuditEntryHash(String(recent[0]!.entryHash), recent[1]!)
      );

      // Verify intact chain
      const verified = log.verifyAuditChain();
      assert.equal(verified.ok, true);
      assert.equal(verified.filesChecked, 1);
      assert.equal(verified.entriesVerified, 2);
      assert.equal(verified.errors.length, 0);

      // Export OCSF format with secret redaction
      const ocsfRaw = formatAuditExport(recent, 'ocsf');
      const ocsfLines = ocsfRaw.trim().split('\n').map((l) => JSON.parse(l));
      assert.equal(ocsfLines.length, 2);
      assert.equal(ocsfLines[0].class_uid, 6003);
      assert.equal(ocsfLines[1].severity_id, 4);
      assert.equal(ocsfLines[1].actor.user.name, 'ci-bot');
      assert.equal(ocsfRaw.includes('sk-ant-api03-'), false);

      // Prune old daily files while keeping today's log
      const logsDir = path.join(auditHome, 'logs');
      fs.writeFileSync(path.join(logsDir, 'audit-2020-01-01.jsonl'), '{"ts":"2020-01-01T00:00:00Z"}\n', 'utf8');
      const pruned = log.pruneAuditLogs(30);
      assert.deepEqual(pruned.deleted, ['audit-2020-01-01.jsonl']);
      assert.equal(pruned.kept, 1);

      // Tamper with line 1 and ensure verifyAuditChain detects it
      const todayFile = log.logFile;
      const lines = fs.readFileSync(todayFile, 'utf8').trim().split('\n');
      const modified = JSON.parse(lines[0]!);
      modified.tool = 'tampered_tool';
      lines[0] = JSON.stringify(modified);
      fs.writeFileSync(todayFile, lines.join('\n') + '\n', 'utf8');

      const tampered = log.verifyAuditChain();
      assert.equal(tampered.ok, false);
      assert.ok(tampered.errors.some((e) => e.line === 1 && /Tampered|mismatch/i.test(e.reason)));
    } finally {
      if (prevHome === undefined) delete process.env.CAUSYNE_HOME;
      else process.env.CAUSYNE_HOME = prevHome;
    }
  });
});
