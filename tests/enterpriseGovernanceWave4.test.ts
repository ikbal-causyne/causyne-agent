import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AuditLog, computeAuditEntryHash, formatAuditExport } from '../src/auditLog.js';
import { runCommand } from '../src/commands.js';
import { matchHookToolPattern, runConfiguredHooks } from '../src/hooks.js';
import { loadProjectInstructions } from '../src/projectInstructions.js';

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

  test('/audit verify, /audit prune, and /audit export --format ocsf work via command dispatcher', async () => {
    const prevHome = process.env.CAUSYNE_HOME;
    const cmdHome = path.join(TMP, 'audit-cmd-home');
    fs.mkdirSync(cmdHome, { recursive: true });
    process.env.CAUSYNE_HOME = cmdHome;
    try {
      const log = new AuditLog();
      log.log({ event: 'tool_executed', tool: 'fs_write', taskId: 'cmd-1' });
      const verifyOk = await runCommand('audit', ['verify'], { surface: 'terminal' });
      assert.equal(verifyOk.ok, true);
      assert.match(verifyOk.output || '', /VERIFIED/);

      const ocsfOut = await runCommand('audit', ['export', '--format', 'ocsf'], { surface: 'terminal' });
      assert.equal(ocsfOut.ok, true);
      const parsed = JSON.parse((ocsfOut.output || '').trim().split('\n')[0]!);
      assert.equal(parsed.class_uid, 6003);

      const pruneOut = await runCommand('audit', ['prune', '--days', '7'], { surface: 'terminal' });
      assert.equal(pruneOut.ok, true);
      assert.match(pruneOut.output || '', /kept 1/);
    } finally {
      if (prevHome === undefined) delete process.env.CAUSYNE_HOME;
      else process.env.CAUSYNE_HOME = prevHome;
    }
  });

  test('hooks support wildcard matchers, secret-redacted stdin, structured JSON decisions, and lifecycle events', async () => {
    assert.equal(matchHookToolPattern('fs_*', 'fs_write'), true);
    assert.equal(matchHookToolPattern('fs_*', 'sysRun'), false);
    assert.equal(matchHookToolPattern('mcp__*', 'mcp__github__search'), true);

    const hookScript = `
      let data = '';
      process.stdin.on('data', (c) => data += c);
      process.stdin.on('end', () => {
        const payload = JSON.parse(data);
        if (JSON.stringify(payload).includes('sk-ant-api03-')) {
          process.stderr.write('SECRET_LEAKED');
          process.exit(2);
        }
        process.stdout.write(JSON.stringify({
          permissionDecision: 'allow',
          updatedInput: { path: 'patched.ts' },
          additionalContext: 'validated by hook'
        }));
      });
    `;
    const decision = await runConfiguredHooks({
      hooks: [{ event: 'PreToolUse', tool: 'fs_*', name: 'guard', command: [process.execPath, '-e', hookScript] }],
      event: 'PreToolUse',
      toolName: 'fs_write',
      args: { path: 'a.ts', content: 'key=sk-ant-api03-123456789012345678901234567890' },
      workspacePaths: [TMP]
    });
    assert.equal(decision.denied, false);
    assert.equal(decision.permissionDecision, 'allow');
    assert.equal(decision.updatedInput?.path, 'patched.ts');
    assert.deepEqual(decision.additionalContext, ['validated by hook']);

    const stopDecision = await runConfiguredHooks({
      hooks: [{
        event: 'Stop',
        name: 'stop-check',
        command: [process.execPath, '-e', 'process.stdout.write(JSON.stringify({ permissionDecision: "deny", reason: "tests still failing" }))']
      }],
      event: 'Stop',
      workspacePaths: [TMP]
    });
    assert.equal(stopDecision.denied, true);
    assert.equal(stopDecision.reason, 'tests still failing');
  });

  test('projectInstructions supports YAML frontmatter paths/globs scoping, same-dir deduplication, and safe @include expansion', () => {
    const ws = path.join(TMP, 'proj-rules-ws');
    fs.mkdirSync(path.join(ws, '.causyne', 'rules'), { recursive: true });
    fs.mkdirSync(path.join(ws, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'docs', 'shared.md'), 'Shared architecture rule.', 'utf8');
    fs.writeFileSync(path.join(ws, 'CAUSYNE.md'), 'Primary rule.\n@include ./docs/shared.md\n@include ../../etc/passwd\n', 'utf8');
    // Identical mirror in AGENTS.md should be deduplicated
    fs.writeFileSync(path.join(ws, 'AGENTS.md'), 'Primary rule.\n@include ./docs/shared.md\n@include ../../etc/passwd\n', 'utf8');
    fs.writeFileSync(
      path.join(ws, '.causyne', 'rules', 'ts-only.md'),
      '---\npaths:\n  - src/**/*.ts\n---\nAlways use strict TypeScript.\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(ws, '.causyne', 'rules', 'always.md'),
      'Global workspace rule.\n',
      'utf8'
    );

    const noActive = loadProjectInstructions(ws, { CAUSYNE_HOME: path.join(TMP, 'empty-home') });
    assert.equal(noActive.entries.filter((e) => e.scope === 'workspace').length, 1, 'identical AGENTS.md must be deduplicated');
    assert.match(noActive.entries[0]!.content, /Shared architecture rule\./);
    assert.equal(noActive.entries.some((e) => e.sourcePath.endsWith('ts-only.md')), false, 'scoped rule must not load without matching activeFiles');
    assert.equal(noActive.entries.some((e) => e.sourcePath.endsWith('always.md')), true);

    const withTsActive = loadProjectInstructions(ws, { CAUSYNE_HOME: path.join(TMP, 'empty-home') }, {
      activeFiles: ['src/core/app.ts']
    });
    assert.equal(withTsActive.entries.some((e) => e.sourcePath.endsWith('ts-only.md')), true);
  });
});
