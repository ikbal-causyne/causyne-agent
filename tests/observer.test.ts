import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { CausyneObserver, defaultObserver } from '../src/observer.js';

test('CausyneObserver evaluates unverified progress on empty history', () => {
  const observer = new CausyneObserver();
  const obs = observer.evaluate({
    taskId: 'test-1',
    workspaceRoot: '/tmp',
    userGoal: 'Build something',
    toolHistory: []
  });
  assert.equal(obs.status, 'progressing');
  assert.equal(obs.verified, false);
});

test('CausyneObserver flags needs-repair on tool failure', () => {
  const observer = new CausyneObserver();
  const obs = observer.evaluate({
    taskId: 'test-2',
    workspaceRoot: '/tmp',
    userGoal: 'Build something',
    toolHistory: [{
      tool: 'sysRun',
      args: { command: 'npm test' },
      success: false,
      error: 'Test suite failed with exit code 1',
      command: 'npm test',
      at: Date.now()
    }]
  });
  assert.equal(obs.status, 'needs-repair');
  assert.equal(obs.verified, false);
  assert.ok(obs.failureKey, 'Expected failureKey to be computed');
});

test('CausyneObserver flags needs-approval on permission/auth error', () => {
  const observer = new CausyneObserver();
  const obs = observer.evaluate({
    taskId: 'test-3',
    workspaceRoot: '/tmp',
    userGoal: 'Access protected file',
    toolHistory: [{
      tool: 'fs_write',
      args: { path: '/etc/hosts' },
      success: false,
      error: 'Permission denied: approval required to write outside workspace',
      at: Date.now()
    }]
  });
  assert.equal(obs.status, 'needs-approval');
  assert.equal(obs.verified, false);
});

test('CausyneObserver flags ready-to-verify when mutations exist but tests have not run', () => {
  const observer = new CausyneObserver();
  const obs = observer.evaluate({
    taskId: 'test-4',
    workspaceRoot: '/tmp',
    userGoal: 'Fix the bug in parser',
    agentClaim: 'I have finished and fixed the bug in parser',
    toolHistory: [{
      tool: 'fs_write',
      args: { path: 'parser.ts' },
      success: true,
      path: 'parser.ts',
      at: Date.now()
    }]
  });
  assert.equal(obs.status, 'ready-to-verify');
  assert.equal(obs.verified, false);
});

test('CausyneObserver marks verified when agent claims completion and tests passed', () => {
  const observer = new CausyneObserver();
  const obs = observer.evaluate({
    taskId: 'test-5',
    workspaceRoot: '/tmp',
    userGoal: 'Fix the bug in parser',
    agentClaim: 'I have finished and verified the parser works',
    toolHistory: [
      {
        tool: 'fs_write',
        args: { path: 'parser.ts' },
        success: true,
        path: 'parser.ts',
        at: Date.now()
      },
      {
        tool: 'sysRun',
        args: { command: 'npm test' },
        success: true,
        command: 'npm test',
        at: Date.now()
      }
    ]
  });
  assert.equal(obs.status, 'verified');
  assert.equal(obs.verified, true);
});

test('CausyneObserver.verifyCode verifies file existence on disk', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-obs-code-'));
  try {
    fs.writeFileSync(path.join(tmp, 'index.ts'), 'export const x = 1;');
    const res = defaultObserver.verifyCode({
      workspaceRoot: tmp,
      changedFiles: ['index.ts']
    });
    assert.equal(res.verified, true);

    const failRes = defaultObserver.verifyCode({
      workspaceRoot: tmp,
      changedFiles: ['nonexistent.ts']
    });
    assert.equal(failRes.verified, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('CausyneObserver.verifyDocs verifies required headings in markdown file', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-obs-docs-'));
  try {
    const docPath = path.join(tmp, 'API.md');
    fs.writeFileSync(docPath, '# API Documentation\n\n## Overview\n\nSome overview.\n\n## Endpoints\n\nSome endpoints.');
    const pass = defaultObserver.verifyDocs({
      workspaceRoot: tmp,
      filePath: 'API.md',
      requiredHeadings: ['Overview', 'Endpoints']
    });
    assert.equal(pass.verified, true);
    assert.equal(pass.missingHeadings.length, 0);

    const fail = defaultObserver.verifyDocs({
      workspaceRoot: tmp,
      filePath: 'API.md',
      requiredHeadings: ['Authentication', 'Changelog']
    });
    assert.equal(fail.verified, false);
    assert.deepEqual(fail.missingHeadings, ['Authentication', 'Changelog']);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('CausyneObserver.verifyCreative verifies asset non-emptiness', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-obs-creative-'));
  try {
    const imagePath = path.join(tmp, 'render.png');
    fs.writeFileSync(imagePath, Buffer.alloc(2048, 1));
    const pass = defaultObserver.verifyCreative({
      workspaceRoot: tmp,
      artifactPath: 'render.png',
      minBytes: 500
    });
    assert.equal(pass.verified, true);
    assert.equal(pass.bytes, 2048);

    const emptyPath = path.join(tmp, 'empty.png');
    fs.writeFileSync(emptyPath, Buffer.alloc(10, 0));
    const fail = defaultObserver.verifyCreative({
      workspaceRoot: tmp,
      artifactPath: 'empty.png',
      minBytes: 500
    });
    assert.equal(fail.verified, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('CausyneObserver.verifyLocalWeb tests loopback endpoint and rejects external URLs', async () => {
  // External URLs are forbidden by security boundary
  const ext = await defaultObserver.verifyLocalWeb({ endpoint: 'http://example.com' });
  assert.equal(ext.verified, false);
  assert.ok(ext.error?.includes('loopback'));

  // Local loopback HTTP test
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as any;
  const endpoint = `http://127.0.0.1:${address.port}`;

  try {
    const local = await defaultObserver.verifyLocalWeb({ endpoint });
    assert.equal(local.verified, true);
    assert.equal(local.statusCode, 200);
  } finally {
    server.close();
  }
});
