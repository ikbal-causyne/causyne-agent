import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { probeAdvisory, queryAdvisory } from '../src/observer/advisory.js';
import { scanMutation } from '../src/observer/evidence.js';

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
});
