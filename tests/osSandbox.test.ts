import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  escapeSeatbeltPath,
  resolveOsSandboxMode,
  probeOsSandbox,
  buildSeatbeltProfile,
  buildBubblewrapArgs,
  wrapCommandWithOsSandbox
} from '../src/tools/osSandbox.js';
import { sysRun } from '../src/tools/sysRun.js';

const TMP_ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-sec2b-')));

after(() => {
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {}
});

describe('Sector 2B — OS-Level Process Sandboxing Wrapper', () => {
  test('escapeSeatbeltPath escapes quotes/backslashes and rejects control characters', () => {
    assert.equal(escapeSeatbeltPath('/tmp/my "proj"\\dir'), '/tmp/my \\"proj\\"\\\\dir');
    assert.equal(escapeSeatbeltPath('/tmp/bad\n(allow default)'), null);
    assert.equal(escapeSeatbeltPath('/tmp/bad\x00path'), null);
    assert.equal(escapeSeatbeltPath(''), null);
  });

  test('resolveOsSandboxMode defaults to workspace-write and honors explicit off/strict/read-only overrides', () => {
    assert.deepEqual(resolveOsSandboxMode({}), { mode: 'workspace-write', strict: false, allowNetwork: true });
    assert.deepEqual(resolveOsSandboxMode({ CAUSYNE_OS_SANDBOX: 'off' }), { mode: 'off', strict: false, allowNetwork: true });
    assert.deepEqual(resolveOsSandboxMode({ CAUSYNE_OS_SANDBOX: '0' }), { mode: 'off', strict: false, allowNetwork: true });
    assert.deepEqual(resolveOsSandboxMode({ CAUSYNE_OS_SANDBOX: 'workspace-write' }), { mode: 'workspace-write', strict: false, allowNetwork: true });
    assert.deepEqual(resolveOsSandboxMode({ CAUSYNE_OS_SANDBOX: 'strict', CAUSYNE_OS_SANDBOX_NETWORK: 'deny' }), { mode: 'workspace-write', strict: true, allowNetwork: false });
    assert.deepEqual(resolveOsSandboxMode({ CAUSYNE_OS_SANDBOX: 'read-only' }), { mode: 'read-only', strict: false, allowNetwork: true });
    assert.deepEqual(resolveOsSandboxMode({}, 'off'), { mode: 'off', strict: false, allowNetwork: true });
    assert.deepEqual(resolveOsSandboxMode({}, 'workspace-write'), { mode: 'workspace-write', strict: false, allowNetwork: true });
  });

  test('buildSeatbeltProfile builds workspace-write, read-only, network-deny, and credential-deny SBPL rules', () => {
    const fakeHome = path.join(TMP_ROOT, 'sbpl-home');
    const ws = path.join(fakeHome, 'project');
    fs.mkdirSync(ws, { recursive: true });

    const profile = buildSeatbeltProfile({
      mode: 'workspace-write',
      cwd: ws,
      workspaceRoots: [ws],
      homeDir: fakeHome,
      allowNetwork: false,
      includeTempDirs: false
    });

    assert.match(profile, /^\(version 1\)/);
    assert.match(profile, /\(deny network-outbound \(remote ip\)\)/);
    assert.match(profile, /\(deny file-write\*\)/);
    assert.ok(profile.includes(`(subpath "${escapeSeatbeltPath(ws)}")`), 'workspace must be writable');
    assert.ok(profile.includes('.ssh'), 'credential stores must be denied');
    assert.ok(profile.includes('.causyne'), 'causyne vault must be denied');
    assert.ok(profile.includes('.bashrc'), 'shell persistence files must be denied');

    // Read-only profile must NOT grant workspace subpath writes
    const roProfile = buildSeatbeltProfile({
      mode: 'read-only',
      cwd: ws,
      workspaceRoots: [ws],
      homeDir: fakeHome,
      includeTempDirs: false
    });
    assert.ok(!roProfile.includes(`(subpath "${escapeSeatbeltPath(ws)}")`), 'read-only must not allow workspace writes');
  });

  test('buildBubblewrapArgs generates shell-free Linux bwrap mount and network isolation argv', () => {
    const fakeHome = path.join(TMP_ROOT, 'bwrap-home');
    const ws = path.join(fakeHome, 'repo');
    const sshDir = path.join(fakeHome, '.ssh');
    fs.mkdirSync(ws, { recursive: true });
    fs.mkdirSync(sshDir, { recursive: true });

    const args = buildBubblewrapArgs('/bin/bash', ['-c', 'echo hi'], {
      mode: 'workspace-write',
      cwd: ws,
      workspaceRoots: [ws],
      homeDir: fakeHome,
      allowNetwork: false
    });

    assert.ok(args.includes('--die-with-parent'));
    assert.ok(args.includes('--ro-bind'));
    assert.ok(args.includes('--unshare-net'));
    const bindIdx = args.indexOf('--bind');
    assert.ok(bindIdx !== -1 && args[bindIdx + 1] === path.resolve(ws));
    const tmpfsIdx = args.lastIndexOf('--tmpfs');
    assert.ok(tmpfsIdx !== -1 && args[tmpfsIdx + 1] === sshDir, 'existing .ssh must be masked by tmpfs');
    assert.deepEqual(args.slice(-4), ['--', '/bin/bash', '-c', 'echo hi']);
  });

  test('wrapCommandWithOsSandbox fails closed when strict=true and backend is unavailable', () => {
    assert.throws(
      () => wrapCommandWithOsSandbox('/bin/bash', ['-c', 'echo hi'], {
        mode: 'workspace-write',
        strict: true,
        cwd: TMP_ROOT,
        platform: 'win32',
        backendOverride: 'none'
      }),
      /Strict OS sandbox requested/
    );

    const degraded = wrapCommandWithOsSandbox('/bin/bash', ['-c', 'echo hi'], {
      mode: 'workspace-write',
      strict: false,
      cwd: TMP_ROOT,
      platform: 'win32',
      backendOverride: 'none'
    });
    assert.equal(degraded.sandboxed, false);
    assert.equal(degraded.command, '/bin/bash');
  });

  test('live kernel sandbox enforcement blocks outside writes & credential reads via sysRun when backend is available', async (t) => {
    const probe = probeOsSandbox();
    if (!probe.available) {
      t.skip(`No live OS sandbox backend in this environment (${probe.reason})`);
      return;
    }

    const fakeHome = path.join(TMP_ROOT, 'live-home');
    const ws = path.join(fakeHome, 'workspace');
    const outsideDir = path.join(fakeHome, 'outside');
    const vaultDir = path.join(fakeHome, '.causyne');
    fs.mkdirSync(ws, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.mkdirSync(vaultDir, { recursive: true });
    fs.writeFileSync(path.join(vaultDir, '.vault_key'), 'TOP_SECRET_KERNEL_TEST_VALUE', 'utf8');

    const sandboxOpts = {
      mode: 'workspace-write' as const,
      cwd: ws,
      workspaceRoots: [ws],
      homeDir: fakeHome,
      includeTempDirs: false,
      allowDevCaches: false
    };

    // 1. Writing inside workspace MUST succeed
    const insideTarget = path.join(ws, 'ok.txt');
    const okRes = await sysRun.execute(
      { command: `echo allowed > "${insideTarget}" && cat "${insideTarget}"`, cwd: ws },
      { skipCache: true, osSandbox: sandboxOpts }
    );
    assert.equal(okRes.success, true, okRes.error || okRes.output);
    assert.match(okRes.output, /allowed/);

    // 2. Writing outside workspace MUST be blocked by the OS kernel
    const outsideTarget = path.join(outsideDir, 'escape.txt');
    const outsideRes = await sysRun.execute(
      { command: `echo escaped > "${outsideTarget}"`, cwd: ws },
      { skipCache: true, osSandbox: sandboxOpts }
    );
    assert.equal(outsideRes.success, false, 'kernel sandbox must block writes outside workspace');
    assert.equal(fs.existsSync(outsideTarget), false, 'escaped file must not exist');

    // 3. Reading ~/.causyne/.vault_key even via `node -e` MUST be blocked by the OS kernel
    const credTarget = path.join(vaultDir, '.vault_key');
    const credRes = await sysRun.execute(
      { command: `node -e 'console.log(require("fs").readFileSync(${JSON.stringify(credTarget)}, "utf8"))'`, cwd: ws },
      { skipCache: true, osSandbox: sandboxOpts }
    );
    assert.equal(credRes.success, false, 'kernel sandbox must block reading credential vault even from node -e');
    assert.ok(!credRes.output.includes('TOP_SECRET_KERNEL_TEST_VALUE'));

    // 4. Read-only mode MUST block even writes inside workspace
    const roTarget = path.join(ws, 'ro-blocked.txt');
    const roRes = await sysRun.execute(
      { command: `echo nope > "${roTarget}"`, cwd: ws },
      { skipCache: true, osSandbox: { ...sandboxOpts, mode: 'read-only' } }
    );
    assert.equal(roRes.success, false, 'read-only kernel sandbox must block workspace writes');
    assert.equal(fs.existsSync(roTarget), false);
  });
});
