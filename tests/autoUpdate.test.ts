import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  compareVersions,
  resolveNpmExecutable,
  installationInfo,
  checkForUpdate,
  runSelfUpdate,
  startUpdateChecker,
  diagnoseInstallation,
  formatDoctorReport
} from '../src/autoUpdate.js';

test('resolveNpmExecutable prioritizes explicit env and falls back to node sibling', () => {
  const custom = resolveNpmExecutable({ CAUSYNE_NPM_COMMAND: '/usr/custom/bin/npm' });
  assert.equal(custom, '/usr/custom/bin/npm');

  const resolved = resolveNpmExecutable({});
  assert.ok(resolved.length > 0);
  if (process.execPath) {
    const isWin = process.platform === 'win32';
    const sibling = path.join(path.dirname(process.execPath), isWin ? 'npm.cmd' : 'npm');
    if (fs.existsSync(sibling)) {
      assert.equal(resolved, sibling);
    }
  }
});

test('version comparison accurately sorts semver releases and prereleases', () => {
  assert.equal(compareVersions('1.20.19', '1.20.18'), 1);
  assert.equal(compareVersions('1.20.18', '1.20.19'), -1);
  assert.equal(compareVersions('1.20.19', '1.20.19'), 0);
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1);
  assert.equal(compareVersions('1.20.19', '1.20.19-beta.1'), 1);
  assert.equal(compareVersions('1.20.19-beta.2', '1.20.19-beta.1'), 1);
});

test('startUpdateChecker applies 2-minute backoff on previous error instead of full lockout', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-update-backoff-'));
  const stateFile = path.join(tmpDir, 'update-state.json');

  // Case 1: Last check was recent (3 minutes ago) but had an error -> should retry after 2 min
  fs.writeFileSync(stateFile, JSON.stringify({
    checkedAt: Date.now() - 3 * 60 * 1000,
    error: 'ETIMEDOUT'
  }));

  let fetchCalled = false;
  const fetchImpl = async () => {
    fetchCalled = true;
    return {
      ok: true,
      json: async () => ({ name: '@causyne/agent', version: '1.20.19' })
    };
  };

  const managedRoot = path.join(tmpDir, 'managed');
  const result = await startUpdateChecker({
    env: { CAUSYNE_INSTALL_ROOT: managedRoot, CAUSYNE_NPM_COMMAND: 'npm' },
    currentVersion: '1.20.19',
    stateFile,
    fetchImpl
  });

  assert.equal(fetchCalled, true);
  assert.equal(result.updated, false);
  assert.equal(result.reason, 'current');

  // Case 2: Explicit 1-hour check interval retains an opt-in startup cache
  fs.writeFileSync(stateFile, JSON.stringify({
    checkedAt: Date.now() - 10 * 60 * 1000,
    latest: '1.20.19'
  }));

  fetchCalled = false;
  const skipResult = await startUpdateChecker({
    env: { CAUSYNE_INSTALL_ROOT: managedRoot, CAUSYNE_NPM_COMMAND: 'npm', CAUSYNE_UPDATE_INTERVAL_MS: '3600000' },
    currentVersion: '1.20.19',
    stateFile,
    fetchImpl
  });

  assert.equal(fetchCalled, false);
  assert.equal(skipResult.reason, 'recently-checked');

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('runSelfUpdate executes global installation with isolated PATH and clean state', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-update-exec-'));
  const stateFile = path.join(tmpDir, 'update-state.json');
  const managedRoot = path.join(tmpDir, 'managed');
  const calls: Array<{ command: string; args: readonly string[]; options: Record<string, unknown> }> = [];

  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ name: '@causyne/agent', version: '1.20.20' })
  });

  const spawnSyncImpl = (command: string, args: readonly string[], options: Record<string, unknown>) => {
    calls.push({ command, args, options });
    return { status: 0, stdout: '', stderr: '', error: undefined, pid: 123, signal: null, output: [] };
  };

  const result = await runSelfUpdate(false, {
    env: { CAUSYNE_INSTALL_ROOT: managedRoot, CAUSYNE_NPM_COMMAND: 'npm' },
    currentVersion: '1.20.19',
    stateFile,
    fetchImpl,
    spawnSyncImpl: spawnSyncImpl as unknown as typeof import('node:child_process').spawnSync
  });

  assert.equal(result.updated, true);
  assert.equal(result.latest, '1.20.20');
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]?.args.slice(0, 4), ['install', '--global', '--prefix', path.resolve(managedRoot)]);
  assert.ok(calls[0]?.args.includes('@causyne/agent@1.20.20'));

  const savedState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(savedState.latest, '1.20.20');
  assert.ok(Number.isFinite(savedState.installedAt));

  fs.rmSync(tmpDir, { recursive: true, force: true });
});

test('diagnoseInstallation and formatDoctorReport include npmCommand and update availability', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({ name: '@causyne/agent', version: '1.20.25' })
  });

  const diagnosis = await diagnoseInstallation({
    currentVersion: '1.20.19',
    fetchImpl
  });

  assert.equal(diagnosis.available, true);
  assert.equal(diagnosis.latest, '1.20.25');
  assert.ok(diagnosis.npmCommand.length > 0);

  const report = formatDoctorReport(diagnosis);
  assert.match(report, /Version\s+:\s+1\.20\.19/);
  assert.match(report, /Latest\s+:\s+1\.20\.25/);
  assert.match(report, /Update\s+:\s+available/);
});

test('bare causyne launch checks registry even if previous check was recent', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-update-on-launch-'));
  const stateFile = path.join(tmpDir, 'update-state.json');
  try {
    fs.writeFileSync(stateFile, JSON.stringify({
      checkedAt: Date.now(),
      latest: '1.20.100'
    }));
    let fetchCount = 0;
    const fetchImpl = async () => {
      fetchCount++;
      return { ok: true, json: async () => ({ name: '@causyne/agent', version: '1.20.100' }) };
    };
    const env = { CAUSYNE_INSTALL_ROOT: path.join(tmpDir, 'managed'), CAUSYNE_NPM_COMMAND: 'npm' };
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await startUpdateChecker({ env, currentVersion: '1.20.100', stateFile, fetchImpl });
      assert.equal(result.reason, 'current');
    }
    assert.equal(fetchCount, 2, 'each bare launch must check for the published version');
    const disabled = await startUpdateChecker({
      env: { ...env, CAUSYNE_DISABLE_AUTOUPDATE: '1' },
      currentVersion: '1.20.100',
      stateFile,
      fetchImpl
    });
    assert.equal(disabled.reason, 'disabled');
    assert.equal(fetchCount, 2, 'explicit auto-update opt-out must never fetch');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
