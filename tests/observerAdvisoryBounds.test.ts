import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { probeAdvisory, queryAdvisory } from '../src/observer/advisory.js';
import { ColdObserver } from '../src/observer/coldObserver.js';
import { scanMutation } from '../src/observer/evidence.js';
import { CausyneObserver, extractClaimedLocalUrls } from '../src/observer.js';

describe('observer advisory parsing and timeout bounds', () => {
  it('queryAdvisory parses valid JSON verdict even when earlier prose contains braces', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        choices: [
          {
            message: {
              content: 'Checking {target} in workspace.\n{"risk": 0.75, "confidence": 0.85, "observation": "Modifies outside path."}'
            }
          }
        ]
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    try {
      const verdict = await queryAdvisory(
        {
          tool: 'fs_write',
          args: { path: 'src/a.ts' },
          findings: ['outside'],
          workspaceRoot: '/tmp'
        },
        {
          endpoint: `http://127.0.0.1:${address.port}/v1`,
          model: 'local-model',
          timeoutMs: 1000
        }
      );
      assert.ok(verdict, 'expected verdict to be parsed despite braces in reasoning prefix');
      assert.equal(verdict?.risk, 0.75);
      assert.equal(verdict?.confidence, 0.85);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('probeAdvisory falls back to safe finite timeout when timeoutMs is NaN instead of aborting after 1ms', async () => {
    const server = http.createServer((_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ data: [] }));
      }, 30);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    try {
      const result = await probeAdvisory({
        endpoint: `http://127.0.0.1:${address.port}/v1`,
        model: 'local-model',
        timeoutMs: Number.NaN
      });
      assert.equal(result.healthy, true);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('scanMutation resolves relative target paths against context.workspaceRoot instead of process.cwd()', () => {
    const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-obs-ws-'));
    try {
      const scan = scanMutation(
        'fs_write',
        { path: 'src/index.ts', content: 'export const ok = true;\n' },
        { workspaceRoot: tmpWs }
      );
      assert.equal(scan.evidence.some((e) => e.code === 'write-outside-workspace'), false);
      assert.equal(scan.evidence.some((e) => e.code === 'write-temporary'), false);
    } finally {
      fs.rmSync(tmpWs, { recursive: true, force: true });
    }
  });

  it('scanMutation detects write-large-shrink on top-level fs_edit arguments and clamps shrink percentage to 100%', () => {
    const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-obs-edit-'));
    try {
      const target = path.join(tmpWs, 'module.ts');
      const original = 'export const line = "x";\n'.repeat(100);
      fs.writeFileSync(target, original, 'utf8');

      const singleEdit = scanMutation(
        'fs_edit',
        { path: 'module.ts', old_string: original, new_string: 'export const x = 1;\n' },
        { workspaceRoot: tmpWs }
      );
      const shrinkEvidence = singleEdit.evidence.find((e) => e.code === 'write-large-shrink');
      assert.ok(shrinkEvidence, 'expected fs_edit removing >80% of >1KB file to trigger write-large-shrink');

      const overShrink = scanMutation(
        'MultiEdit',
        {
          path: 'module.ts',
          edits: [
            { old_string: original, new_string: '' },
            { old_string: original, new_string: '' }
          ]
        },
        { workspaceRoot: tmpWs }
      );
      const overEvidence = overShrink.evidence.find((e) => e.code === 'write-large-shrink');
      assert.ok(overEvidence);
      assert.match(overEvidence.detail, /removes about 100%/);
    } finally {
      fs.rmSync(tmpWs, { recursive: true, force: true });
    }
  });

  it('ColdObserver.auditTurnVerification flags passing-test claim when the latest test run failed and only fs_read succeeded afterward', async () => {
    const observer = new ColdObserver({ enabled: true, mode: 'deterministic', timeoutMs: Number.NaN });
    assert.equal(Number.isFinite(observer.getConfig().timeoutMs), true);

    observer.beginTask('task-latest-test-fail');
    observer.recordToolOutcome('task-latest-test-fail', 'fs_edit', { path: 'src/app.ts' }, { success: true });
    observer.recordToolOutcome('task-latest-test-fail', 'sysRun', { command: 'npm test' }, { success: true, exitCode: 0 });
    observer.recordToolOutcome('task-latest-test-fail', 'sysRun', { command: 'npm test' }, { success: false, exitCode: 1, error: '1 test failed' });
    observer.recordToolOutcome('task-latest-test-fail', 'fs_read', { path: 'src/app.ts' }, { success: true });

    const audit = await observer.auditTurnVerification({
      taskId: 'task-latest-test-fail',
      userPrompt: 'Fix the bug and run tests',
      agentClaim: 'All tests passed and the bug is fixed.',
      toolHistory: [],
      stepsCompleted: 4
    });
    assert.equal(audit.verified, false);
    assert.equal(audit.overconfident, true);
  });

  it('extractClaimedLocalUrls strips unmatched closing bracket and CausyneObserver rejects stale verification after failed test', async () => {
    assert.deepEqual(
      extractClaimedLocalUrls('Server running at [http://localhost:3000/health]. Also [http://[::1]:8080/status]'),
      ['http://localhost:3000/health', 'http://[::1]:8080/status']
    );

    const obs = new CausyneObserver();
    const evaluation = obs.evaluate({
      taskId: 't1',
      workspaceRoot: '/tmp',
      userGoal: 'fix bug',
      agentClaim: 'The bug is fixed and complete.',
      toolHistory: [
        { tool: 'fs_edit', args: {}, success: true, error: '', exitCode: null, command: '', path: 'src/a.ts', at: 1 },
        { tool: 'sysRun', args: {}, success: true, error: '', exitCode: 0, command: 'npm test', path: '', at: 2 },
        { tool: 'sysRun', args: {}, success: false, error: 'fail', exitCode: 1, command: 'npm test', path: '', at: 3 },
        { tool: 'fs_read', args: {}, success: true, error: '', exitCode: null, command: '', path: 'src/a.ts', at: 4 }
      ]
    });
    assert.equal(evaluation.verified, false);
  });
});
