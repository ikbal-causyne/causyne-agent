import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { ColdObserver } from '../src/observer/coldObserver.js';
import { runCommand } from '../src/commands.js';

const workspaceRoot = process.cwd();

function localObserver(config = {}) {
  return new ColdObserver({ enabled: true, mode: 'deterministic', endpoint: '', model: '', ...config });
}

test('cold observer vetoes only catastrophic invariants', async () => {
  const observer = localObserver();

  const wipe = await observer.evaluateMutation('sysRun', { command: 'rm -rf /' }, { workspaceRoot });
  assert.equal(wipe.veto, true);
  assert.equal(wipe.allowed, false);
  assert.equal(wipe.riskScore, 1);

  const preserveRoot = await observer.evaluateMutation('sysRun', { command: 'rm -rf --no-preserve-root /' }, { workspaceRoot });
  assert.equal(preserveRoot.veto, true);

  const format = await observer.evaluateMutation('sysRun', { command: 'mkfs.ext4 /dev/sda1' }, { workspaceRoot });
  assert.equal(format.veto, true);
});

test('cold observer asks for confirmation on high-risk but recoverable mutations', async () => {
  const observer = localObserver();

  const reset = await observer.evaluateMutation('sysRun', { command: 'git reset --hard HEAD~5' }, { workspaceRoot });
  assert.equal(reset.veto, false);
  assert.equal(reset.allowed, true);
  assert.equal(reset.requiresConfirmation, true);

  const drop = await observer.evaluateMutation('sysRun', { command: 'psql -c "DROP TABLE users;"' }, { workspaceRoot });
  assert.equal(drop.requiresConfirmation, true);

  const outside = await observer.evaluateMutation('fs_write', { path: path.join(os.homedir(), 'notes.txt'), content: 'x' }, { workspaceRoot });
  assert.equal(outside.requiresConfirmation, true);
  assert.equal(outside.veto, false);
});

test('cold observer leaves benign actions alone', async () => {
  const observer = localObserver();

  const read = await observer.evaluateMutation('fs_read', { path: 'package.json' }, { workspaceRoot });
  assert.equal(read.riskScore, 0);
  assert.equal(read.requiresConfirmation, false);
  assert.equal(read.allowed, true);

  const write = await observer.evaluateMutation('fs_write', { path: 'src/feature.js', content: 'export const x = 1;\n' }, { workspaceRoot });
  assert.equal(write.requiresConfirmation, false);

  const tests = await observer.evaluateMutation('sysRun', { command: 'npm test' }, { workspaceRoot });
  assert.equal(tests.requiresConfirmation, false);
});

test('cold observer marks critical project files and git metadata', async () => {
  const observer = localObserver();

  const env = await observer.evaluateMutation('fs_write', { path: '.env', content: 'TOKEN=1' }, { workspaceRoot });
  assert.equal(env.requiresConfirmation, true);
  assert.ok(env.findings.some((finding) => finding.includes('.env')));

  const git = await observer.evaluateMutation('fs_write', { path: '.git/config', content: '[core]' }, { workspaceRoot });
  assert.equal(git.requiresConfirmation, true);

  const rootDelete = await observer.evaluateMutation('fs_delete', { path: '.', recursive: true }, { workspaceRoot });
  assert.equal(rootDelete.veto, true);
});

test('cold observer reports truncating rewrites of existing files', async () => {
  const observer = localObserver();
  const target = path.join(workspaceRoot, 'src', 'agentLoop.js');
  const truncate = await observer.evaluateMutation('fs_write', { path: target, content: '' }, { workspaceRoot });
  assert.equal(truncate.requiresConfirmation, true);
  assert.ok(truncate.findings.some((finding) => finding.includes('empty file')));
});

test('cold observer ignores unrecognised tools and disabled mode', async () => {
  const observer = localObserver();
  const unknown = await observer.evaluateMutation('image_generate', { prompt: 'x' }, { workspaceRoot });
  assert.equal(unknown.riskScore, 0);

  const disabled = localObserver({ enabled: false });
  const blocked = await disabled.evaluateMutation('sysRun', { command: 'rm -rf /' }, { workspaceRoot });
  assert.equal(blocked.veto, false);
  assert.equal(blocked.allowed, true);
});

test('completion audit flags an unverified test claim', async () => {
  const observer = localObserver();
  observer.beginTask('task-a');
  observer.recordToolOutcome('task-a', 'fs_edit', { path: 'src/app.js' }, { success: true });

  const audit = await observer.auditTurnVerification({
    taskId: 'task-a',
    userPrompt: 'fix the bug',
    agentClaim: 'Done. All tests pass.',
    toolHistory: [],
    stepsCompleted: 4
  });
  assert.equal(audit.overconfident, true);
  assert.equal(audit.verified, false);
  assert.match(audit.discrepancy, /tests/);
  assert.match(audit.coldDirective, /\[OBSERVER\]/);
});

test('completion audit flags a claim contradicted by the last tool result', async () => {
  const observer = localObserver();
  observer.beginTask('task-b');
  observer.recordToolOutcome('task-b', 'fs_edit', { path: 'src/app.js' }, { success: true });
  observer.recordToolOutcome('task-b', 'sysRun', { command: 'npm test' }, { success: false, error: '2 failing' });

  const audit = await observer.auditTurnVerification({
    taskId: 'task-b',
    userPrompt: 'fix the bug',
    agentClaim: 'Everything is done and working.',
    toolHistory: [],
    stepsCompleted: 6
  });
  assert.equal(audit.overconfident, true);
  assert.match(audit.discrepancy, /conflicts/);
});

test('completion audit accepts a verified test claim', async () => {
  const observer = localObserver();
  observer.beginTask('task-c');
  observer.recordToolOutcome('task-c', 'fs_edit', { path: 'src/app.js' }, { success: true });
  observer.recordToolOutcome('task-c', 'sysRun', { command: 'npm test' }, { success: true });

  const audit = await observer.auditTurnVerification({
    taskId: 'task-c',
    userPrompt: 'fix the bug',
    agentClaim: 'All tests pass.',
    toolHistory: [],
    stepsCompleted: 6
  });
  assert.equal(audit.overconfident, false);
  assert.equal(audit.verified, true);
});

test('completion audit respects an honest caveat', async () => {
  const observer = localObserver();
  observer.beginTask('task-d');
  observer.recordToolOutcome('task-d', 'fs_edit', { path: 'src/app.js' }, { success: true });

  const audit = await observer.auditTurnVerification({
    taskId: 'task-d',
    userPrompt: 'fix the bug',
    agentClaim: 'The patch is done, but I have not run the tests yet.',
    toolHistory: [],
    stepsCompleted: 3
  });
  assert.equal(audit.overconfident, false);
});

test('completion audit still reads legacy tool history', async () => {
  const observer = localObserver();
  const audit = await observer.auditTurnVerification({
    userPrompt: 'fix the bug',
    agentClaim: 'Done, everything works.',
    toolHistory: [
      { tool: 'fs_write', success: true, args: { path: 'src/app.js' } },
      { tool: 'sysRun', success: false, result: { error: 'permission denied' } }
    ],
    stepsCompleted: 5
  });
  assert.equal(audit.overconfident, true);
});

test('advisory mode consults only a loopback endpoint and never lowers risk', async () => {
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests += 1;
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        choices: [{ message: { content: '{"risk":0.95,"confidence":0.9,"observation":"overwrites a tracked file"}' } }]
      }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const endpoint = `http://127.0.0.1:${address.port}`;

  try {
    const observer = localObserver({ mode: 'advisory', endpoint, model: 'tiny', timeoutMs: 2000, strictness: 'standard' });
    const raised = await observer.evaluateMutation('fs_move', {
      source: 'src/a.js',
      destination: 'src/b.js',
      overwrite: true
    }, { workspaceRoot });
    assert.equal(requests, 1);
    assert.ok(raised.riskScore > 0.65);
    assert.equal(raised.requiresConfirmation, true);
    assert.ok(raised.evidence.some((item) => item.source === 'advisory'));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('advisory mode cannot lower a deterministic score and stays off when deterministic', async () => {
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests += 1;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { content: '{"risk":0.05,"confidence":0.9,"observation":"looks fine"}' } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const endpoint = `http://127.0.0.1:${address.port}`;

  try {
    const observer = localObserver({ mode: 'advisory', endpoint, model: 'tiny', timeoutMs: 2000, strictness: 'relaxed' });
    const unchanged = await observer.evaluateMutation('fs_move', { overwrite: true, source: 'src/a.js', destination: 'src/b.js' }, { workspaceRoot });
    assert.ok(unchanged.riskScore <= 0.7000001);
    assert.equal(requests, 1);

    const deterministic = localObserver({ endpoint, model: 'tiny', strictness: 'relaxed' });
    await deterministic.evaluateMutation('fs_move', { overwrite: true, source: 'src/a.js', destination: 'src/b.js' }, { workspaceRoot });
    assert.equal(requests, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('observer configuration rejects non-loopback endpoints', () => {
  const observer = localObserver();
  assert.throws(() => observer.updateConfig({ endpoint: 'http://example.com/v1' }), /loopback/);
  assert.throws(() => observer.updateConfig({ mode: 'wild' }), /mode/);
  observer.updateConfig({ endpoint: 'http://localhost:11434/v1', model: 'tiny', strictness: 'strict' });
  const config = observer.getConfig();
  assert.equal(config.endpoint, 'http://localhost:11434/v1');
  assert.equal(config.strictness, 'strict');
});

test('/observer reports status without unrelated branding', async () => {
  const result = await runCommand('observer', ['status']);
  assert.equal(result.ok, true);
  assert.match(result.output, /Cold Observer/);
  assert.doesNotMatch(result.output, /Dingin/);
});
