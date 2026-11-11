import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { CausyneObserver, defaultObserver, extractClaimedLocalUrls } from '../src/observer.js';
import { coldObserver } from '../src/observer/coldObserver.js';
import { outcomeFromResult } from '../src/observer/evidence.js';

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

test('outcomeFromResult extracts CommandLine and commandLine correctly', () => {
  const o1 = outcomeFromResult('run_command', { CommandLine: 'node --test test_suite.js' }, { success: true, exitCode: 0 }, 100);
  assert.equal(o1.command, 'node --test test_suite.js');

  const o2 = outcomeFromResult('run_command', { commandLine: 'pytest -v' }, { success: true }, 101);
  assert.equal(o2.command, 'pytest -v');

  const o3 = outcomeFromResult('run_command', { detail: 'cargo test' }, { success: true }, 102);
  assert.equal(o3.command, 'cargo test');
});

test('coldObserver recognizes test run via CommandLine and avoids overconfident penalty', async () => {
  const taskId = 'task-test-cmdline-1';
  coldObserver.recordToolOutcome(taskId, 'write_file', { path: '/tmp/test.js', content: 'hello' }, { success: true });
  coldObserver.recordToolOutcome(taskId, 'run_command', { CommandLine: 'node --test test_suite.js' }, { success: true, exitCode: 0 });

  const assessment = await coldObserver.auditTurnVerification({
    taskId,
    userPrompt: 'add test and make sure all tests pass',
    agentClaim: 'Completed. Ran test_suite.js: 6 passed, 0 failed.',
    toolHistory: coldObserver.getToolOutcomes(taskId),
    stepsCompleted: 2
  });

  assert.equal(assessment.overconfident, false);
  assert.equal(assessment.verified, true);
});

test('coldObserver does not force test checks on launch-only prompts ("open it ")', async () => {
  const taskId = 'task-launch-only-1';
  coldObserver.recordToolOutcome(taskId, 'run_command', { CommandLine: 'open /tmp/project/index.html' }, { success: true, exitCode: 0 });

  const assessment = await coldObserver.auditTurnVerification({
    taskId,
    userPrompt: 'open it ',
    agentClaim: 'The project was inspected and opened in the browser. 6 tests passed.',
    toolHistory: coldObserver.getToolOutcomes(taskId),
    stepsCompleted: 1
  });

  assert.equal(assessment.overconfident, false);
  assert.equal(assessment.verified, true);
});

test('extractClaimedLocalUrls extracts loopback URLs and strips trailing punctuation cleanly', () => {
  const urls = extractClaimedLocalUrls(
    'The 3D Burger CAD application is running at http://localhost:8098. Secondary preview: http://127.0.0.1:5173/index.html!'
  );
  assert.deepEqual(urls, ['http://localhost:8098', 'http://127.0.0.1:5173/index.html']);
});

test('coldObserver recognizes "is running at http://localhost:..." as a completion claim and catches unverified code changes', async () => {
  const taskId = 'task-running-at-claim-1';
  coldObserver.beginTask(taskId);
  coldObserver.recordToolOutcome(taskId, 'write_file', { path: '/tmp/app.js', content: 'console.log(1);' }, { success: true });

  const assessment = await coldObserver.auditTurnVerification({
    taskId,
    userPrompt: 'make 3d burger cad style view usingthree.js',
    agentClaim: 'The 3D Burger CAD application is running at http://localhost:8098.',
    toolHistory: coldObserver.getToolOutcomes(taskId),
    stepsCompleted: 1
  });

  assert.equal(assessment.overconfident, true);
  assert.equal(assessment.verified, false);
  assert.match(assessment.discrepancy, /code was modified without a successful test or syntax check/);
});

test('verifyCode cannot verify an unspecified deliverable set', () => {
  assert.equal(defaultObserver.verifyCode({ workspaceRoot: os.tmpdir() }).verified, false);
  assert.equal(defaultObserver.verifyCode({ workspaceRoot: os.tmpdir(), changedFiles: [] }).evidence, 'no_files');
});

test('verifyCode rejects empty files and directories', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-empty-'));
  try { fs.writeFileSync(path.join(root, 'blank.js'), ''); fs.mkdirSync(path.join(root, 'subdir'));
    for (const target of ['blank.js', 'subdir']) assert.equal(defaultObserver.verifyCode({ workspaceRoot: root, changedFiles: [target] }).evidence, 'invalid_file');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('verifyDocs reports a directory as invalid instead of throwing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-doc-dir-'));
  try { assert.deepEqual(defaultObserver.verifyDocs({ workspaceRoot: root, filePath: '.', requiredHeadings: ['Overview'] }), { verified: false, missingHeadings: ['Overview'] }); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('verifyCreative rejects directories regardless of apparent size', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-art-dir-'));
  try { assert.equal(defaultObserver.verifyCreative({ workspaceRoot: root, artifactPath: '.', minBytes: 0 }).verified, false); }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('verifyCreative rejects negative and NaN size thresholds', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-art-size-'));
  try { fs.writeFileSync(path.join(root, 'a.bin'), 'abc');
    for (const minBytes of [-1, Number.NaN, Number.POSITIVE_INFINITY]) assert.equal(defaultObserver.verifyCreative({ workspaceRoot: root, artifactPath: 'a.bin', minBytes }).verified, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('verifyLocalWeb respects explicitly required HTTP status', async () => {
  const server = http.createServer((_req, res) => { res.writeHead(204); res.end(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try { const port = (server.address() as any).port;
    const result = await defaultObserver.verifyLocalWeb({ endpoint: `http://127.0.0.1:${port}`, expectedStatus: 200 });
    assert.equal(result.statusCode, 204); assert.equal(result.verified, false);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('verifyLocalWeb does not count an HTTP redirect as a working page', async () => {
  const server = http.createServer((_req, res) => { res.writeHead(302, { location: 'http://example.com/' }); res.end(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try { const port = (server.address() as any).port;
    const result = await defaultObserver.verifyLocalWeb({ endpoint: `http://127.0.0.1:${port}` });
    assert.equal(result.statusCode, 302); assert.equal(result.verified, false);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('verifyLocalWeb rejects credentials embedded in local URLs', async () => {
  const url = new URL('http://127.0.0.1:12345/');
  url.username = 'user';
  url.password = 'test';
  const result = await defaultObserver.verifyLocalWeb({ endpoint: url.href });
  assert.equal(result.verified, false);
  assert.match(result.error ?? '', /credentials/);
});

test('observer does not reuse test evidence from before the latest edit', () => {
  const obs = defaultObserver.evaluate({ taskId: 'stale-test', workspaceRoot: '/tmp', userGoal: 'Fix parser', agentClaim: 'Fixed', toolHistory: [
    { tool: 'sysRun', args: {}, success: true, error: '', exitCode: 0, path: '', command: 'npm test', at: 1 },
    { tool: 'fs_write', args: {}, success: true, error: '', exitCode: null, path: 'parser.ts', command: '', at: 2 }
  ] });
  assert.equal(obs.status, 'ready-to-verify');
  assert.equal(obs.verified, false);
});

test('observer does not treat a browser action without rendered evidence as verification', () => {
  const obs = defaultObserver.evaluate({ taskId: 'no-render', workspaceRoot: '/tmp', userGoal: 'Build UI', agentClaim: 'Implemented', toolHistory: [
    { tool: 'fs_edit', args: {}, success: true, error: '', exitCode: null, path: 'ui.ts', command: '', at: 1 },
    { tool: 'browser_act', args: {}, success: true, error: '', exitCode: 0, path: '', command: '', rendered: false, at: 2 }
  ] });
  assert.equal(obs.status, 'ready-to-verify');
  assert.equal(obs.verified, false);
});

test('observer cannot mark verification passed after nonzero test exit code', () => {
  const obs = defaultObserver.evaluate({
    taskId: 'failed-check-status',
    workspaceRoot: '/tmp',
    userGoal: 'Fix parser',
    agentClaim: 'Fixed the parser',
    toolHistory: [
      { tool: 'fs_edit', args: {}, success: true, error: '', exitCode: null, path: 'parser.ts', command: '', at: 1 },
      { tool: 'sysRun', args: { command: 'npm test' }, success: true, error: '', exitCode: 1, path: '', command: 'npm test', at: 2 }
    ]
  });
  assert.equal(obs.verified, false);
  assert.equal(obs.status, 'ready-to-verify');
});

test('observer does not treat negated completion statements as success claims', () => {
  for (const agentClaim of ['Not done yet.', 'The task is not fixed.', 'I have never verified it.', 'It is not fully completed.']) {
    const obs = defaultObserver.evaluate({
      taskId: 'negated-claim',
      workspaceRoot: '/tmp',
      userGoal: 'Fix parser',
      agentClaim,
      toolHistory: [{ tool: 'sysRun', args: {}, success: true, error: '', exitCode: 0, path: '', command: 'npm test', at: 1 }]
    });
    assert.notEqual(obs.status, 'verified', agentClaim);
    assert.equal(obs.verified, false, agentClaim);
  }
});

test('observer code, docs and creative verification cannot authenticate files outside workspace', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-obs-scope-root-'));
  const external = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-obs-scope-outside-'));
  try {
    const outsideCode = path.join(external, 'app.js');
    const outsideDocs = path.join(external, 'README.md');
    const outsideImage = path.join(external, 'render.png');
    fs.writeFileSync(outsideCode, 'export const valid = true;');
    fs.writeFileSync(outsideDocs, '# Overview\n');
    fs.writeFileSync(outsideImage, Buffer.alloc(512, 1));

    assert.equal(defaultObserver.verifyCode({ workspaceRoot: root, changedFiles: [outsideCode] }).evidence, 'outside_workspace');
    assert.equal(defaultObserver.verifyCode({ workspaceRoot: root, changedFiles: [path.relative(root, outsideCode)] }).verified, false);
    assert.equal(defaultObserver.verifyDocs({ workspaceRoot: root, filePath: outsideDocs, requiredHeadings: ['Overview'] }).verified, false);
    assert.equal(defaultObserver.verifyCreative({ workspaceRoot: root, artifactPath: outsideImage, minBytes: 100 }).verified, false);

    fs.writeFileSync(path.join(root, 'app.js'), 'export const valid = true;');
    assert.equal(defaultObserver.verifyCode({ workspaceRoot: root, changedFiles: ['app.js'] }).verified, true);
    const symlink = path.join(root, 'outside-app.js');
    try {
      fs.symlinkSync(outsideCode, symlink);
    } catch (error) {
      if (!['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      return;
    }
    assert.equal(defaultObserver.verifyCode({ workspaceRoot: root, changedFiles: ['outside-app.js'] }).verified, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(external, { recursive: true, force: true });
  }
});
