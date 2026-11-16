import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runInteractivePty } from '../src/verification/interactivePty.js';
import { verifyCausyneTui } from '../src/verification/uiRuntime.js';

const root = process.cwd();

test('live Causyne TUI renders usage and status across real PTY interactions', async t => {
  if (process.platform === 'win32') return t.skip('ConPTY adapter not installed');
  const result = await verifyCausyneTui({ workspace: root, timeoutMs: 20000 });
  if (result.status === 'unavailable') return t.skip(result.reason);
  assert.equal(result.status, 'observed-pass', JSON.stringify({
    observations: result.observations, error: result.stderr?.slice(-1500),
    outputTail: result.stdout?.slice(-1700), exitCode: result.exitCode,
    timedOut: result.timedOut
  }));
  assert.deepEqual(result.observations.map(x => x.name),
    ['open-usage', 'submit-while-pinned', 'switch-to-status', 'submit-while-status-pinned']);
  assert.ok(result.observations.every(x => x.matched));
  assert.equal(result.exitCode, 0);
  assert.equal(result.surface, 'posix-pty');
});

test('PTY verifier rejects a missing visible user path rather than passing on exit code alone', async t => {
  if (process.platform === 'win32') return t.skip('ConPTY adapter not installed');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-ui-probe-test-'));
  try {
    const result = await runInteractivePty({
      workspace: root, script: 'tests/fixtures/liveTuiTarget.mjs',
      env: { CAUSYNE_HOME: tmp }, timeoutMs: 1300,
      steps: [{ name: 'nonexistent', waitFor: 'NEVER_PRESENT',
        input: '/usage\r', contains: 'Usage & Context' }]
    });
    if (result.status === 'unavailable') return t.skip(result.reason);
    assert.equal(result.status, 'observed-fail');
    assert.equal(result.completed, false);
    assert.equal(result.timedOut, true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('PTY verifier cannot be pointed at an external executable or existing user home', async () => {
  const isolated = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-pty-path-'));
  try {
    await assert.rejects(runInteractivePty({
      workspace: root, script: '../../somewhere.js',
      env: { CAUSYNE_HOME: isolated },
      steps: [{ name: 'probe', waitFor: 'READY', input: '', contains: '' }]
    }), /ENOENT|workspace/);
  } finally {
    fs.rmSync(isolated, { recursive: true, force: true });
  }
  await assert.rejects(runInteractivePty({
    workspace: root, script: 'tests/fixtures/liveTuiTarget.mjs',
    env: {}, steps: [{ name: 'probe', waitFor: 'READY', input: '', contains: '' }]
  }), /CAUSYNE_HOME/);
  await assert.rejects(runInteractivePty({
    workspace: root, script: 'tests/fixtures/liveTuiTarget.mjs',
    env: { CAUSYNE_HOME: os.homedir() },
    steps: [{ name: 'probe', waitFor: 'READY', input: '', contains: 'READY' }]
  }), /isolated temporary/);
});
