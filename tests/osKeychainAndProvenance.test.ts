import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SpawnSyncReturns } from 'node:child_process';

import {
  keychainAccountForVaultDir,
  loadVaultKeyFromKeychain,
  probeOsKeychain,
  resolveKeychainMode,
  saveVaultKeyToKeychain
} from '../src/osKeychain.js';
import { getOrCreateVaultKey } from '../src/configVault.js';
import {
  checkForUpdate,
  diagnoseInstallation,
  formatDoctorReport,
  verifyRegistryMetadataIntegrity,
  verifyTarballIntegrity
} from '../src/autoUpdate.js';

const TMP_ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-sec6c-')));

after(() => {
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {}
});

function okSpawn(stdout = ''): SpawnSyncReturns<string> {
  return { pid: 1, output: ['', stdout, ''], stdout, stderr: '', status: 0, signal: null };
}

function failSpawn(status = 1): SpawnSyncReturns<string> {
  return { pid: 1, output: ['', '', 'err'], stdout: '', stderr: 'err', status, signal: null };
}

describe('Sector 6C — OS Keychain Master-Key Backend', () => {
  test('resolveKeychainMode defaults to off and recognizes auto/on/strict', () => {
    assert.equal(resolveKeychainMode({}), 'off');
    assert.equal(resolveKeychainMode({ CAUSYNE_KEYCHAIN: 'auto' }), 'auto');
    assert.equal(resolveKeychainMode({ CAUSYNE_KEYCHAIN: 'on' }), 'on');
    assert.equal(resolveKeychainMode({ CAUSYNE_KEYCHAIN: 'strict' }), 'strict');
    assert.equal(resolveKeychainMode({ CAUSYNE_KEYCHAIN: '0' }), 'off');
  });

  test('macOS Keychain saves via `/usr/bin/security -i` stdin (never argv) and loads 32-byte key', () => {
    const vaultDir = path.join(TMP_ROOT, 'mac-vault');
    const key = crypto.randomBytes(32);
    const hex = key.toString('hex');
    const account = keychainAccountForVaultDir(vaultDir);
    const calls: Array<{ cmd: string; args: readonly string[]; input?: unknown }> = [];

    const saved = saveVaultKeyToKeychain(vaultDir, key, {
      platform: 'darwin',
      spawnSyncImpl: (cmd, args, opts) => {
        calls.push({ cmd, args, input: opts.input });
        return okSpawn();
      }
    });
    assert.equal(saved, true);
    assert.equal(calls[0]?.cmd, '/usr/bin/security');
    assert.deepEqual(calls[0]?.args, ['-i'], 'must pass secret via stdin interactive mode, never argv');
    assert.ok(!calls[0]!.args.join(' ').includes(hex), 'hex key must never appear in process argv');
    assert.ok(String(calls[0]?.input).includes(account));
    assert.ok(String(calls[0]?.input).includes(hex));

    const loaded = loadVaultKeyFromKeychain(vaultDir, {
      platform: 'darwin',
      spawnSyncImpl: (_cmd, args) => {
        assert.ok(args.includes('find-generic-password'));
        assert.ok(args.includes(account));
        return okSpawn(`${hex}\n`);
      }
    });
    assert.ok(loaded && loaded.equals(key));
  });

  test('Linux Secret Service uses secret-tool stdin (never argv) and Windows uses DPAPI CurrentUser blob', () => {
    const vaultDir = path.join(TMP_ROOT, 'linux-win-vault');
    const key = crypto.randomBytes(32);
    const hex = key.toString('hex');

    // Linux secret-tool
    let linuxInput = '';
    const linuxSaved = saveVaultKeyToKeychain(vaultDir, key, {
      platform: 'linux',
      spawnSyncImpl: (cmd, args, opts) => {
        assert.equal(cmd, 'secret-tool');
        assert.ok(!args.join(' ').includes(hex));
        linuxInput = String(opts.input || '');
        return okSpawn();
      }
    });
    assert.equal(linuxSaved, true);
    assert.equal(linuxInput, hex);

    const linuxLoaded = loadVaultKeyFromKeychain(vaultDir, {
      platform: 'linux',
      spawnSyncImpl: () => okSpawn(`${hex}\n`)
    });
    assert.ok(linuxLoaded && linuxLoaded.equals(key));

    // Windows DPAPI blob round-trip
    const winVaultDir = path.join(TMP_ROOT, 'win-vault');
    const fakeProtected = Buffer.from(`DPAPI:${hex}`).toString('base64');
    const winSaved = saveVaultKeyToKeychain(winVaultDir, key, {
      platform: 'win32',
      spawnSyncImpl: (cmd, args, opts) => {
        assert.equal(cmd, 'powershell.exe');
        assert.ok(!args.join(' ').includes(hex));
        assert.equal(opts.input, hex);
        return okSpawn(fakeProtected);
      }
    });
    assert.equal(winSaved, true);
    assert.equal(fs.existsSync(path.join(winVaultDir, '.vault_key.dpapi')), true);

    const winLoaded = loadVaultKeyFromKeychain(winVaultDir, {
      platform: 'win32',
      spawnSyncImpl: (_cmd, _args, opts) => {
        assert.equal(opts.input, fakeProtected);
        return okSpawn(hex);
      }
    });
    assert.ok(winLoaded && winLoaded.equals(key));
  });

  test('getOrCreateVaultKey migrates existing file key to keychain and fails closed in strict mode', () => {
    const migrateDir = path.join(TMP_ROOT, 'migrate-kc');
    fs.mkdirSync(migrateDir, { recursive: true });
    const keyFile = path.join(migrateDir, '.vault_key');
    const existing = crypto.randomBytes(32);
    fs.writeFileSync(keyFile, existing, { mode: 0o600 });

    let storedHex = '';
    const resolved = getOrCreateVaultKey(keyFile, {
      platform: 'linux',
      env: { CAUSYNE_KEYCHAIN: 'on' },
      spawnSyncImpl: (_cmd, args, opts) => {
        if (args[0] === 'lookup') return failSpawn(1);
        storedHex = String(opts.input || '');
        return okSpawn();
      }
    });
    assert.ok(resolved.equals(existing));
    assert.equal(storedHex, existing.toString('hex'));

    // Strict mode throws when keychain is unavailable
    const strictKeyFile = path.join(TMP_ROOT, 'strict-kc', '.vault_key');
    assert.throws(
      () => getOrCreateVaultKey(strictKeyFile, {
        platform: 'linux',
        env: { CAUSYNE_KEYCHAIN: 'strict' },
        spawnSyncImpl: () => failSpawn(1)
      }),
      /Strict OS keychain mode requested/
    );
  });

  test('probeOsKeychain reports honest platform capability', () => {
    const winCap = probeOsKeychain({ platform: 'win32' });
    assert.equal(winCap.backend, 'windows-dpapi');
    assert.equal(winCap.available, true);
  });
});

describe('Sector 6C — Self-Update Integrity & Provenance Verification', () => {
  test('verifyTarballIntegrity validates SHA-512 and SHA-256 SRI digests in constant time', () => {
    const payload = Buffer.from('deterministic-release-tarball-bytes', 'utf8');
    const sha512 = `sha512-${crypto.createHash('sha512').update(payload).digest('base64')}`;
    const sha256 = `sha256-${crypto.createHash('sha256').update(payload).digest('base64')}`;

    assert.equal(verifyTarballIntegrity(payload, sha512), true);
    assert.equal(verifyTarballIntegrity(payload, sha256), true);
    assert.equal(verifyTarballIntegrity(Buffer.from('tampered'), sha512), false);
    assert.equal(verifyTarballIntegrity(payload, 'md5-deadbeef'), false);
  });

  test('verifyRegistryMetadataIntegrity enforces official HTTPS tarball origin, valid SRI, and provenance attestation checks', () => {
    const valid = verifyRegistryMetadataIntegrity({
      name: '@causyne/agent',
      version: '1.20.121',
      dist: {
        tarball: 'https://registry.npmjs.org/@causyne/agent/-/agent-1.20.121.tgz',
        integrity: 'sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
        attestations: {
          url: 'https://registry.npmjs.org/-/npm/v1/attestations/@causyne%2fagent@1.20.121',
          provenance: { predicateType: 'https://slsa.dev/provenance/v1' }
        }
      }
    }, { requireProvenance: true });

    assert.equal(valid.version, '1.20.121');
    assert.equal(valid.provenanceVerified, true);

    // Reject cleartext HTTP or foreign tarball origin
    assert.throws(() => verifyRegistryMetadataIntegrity({
      name: '@causyne/agent',
      version: '1.20.121',
      dist: { tarball: 'http://registry.npmjs.org/@causyne/agent/-/agent-1.20.121.tgz' }
    }), /registry\.npmjs\.org/);

    assert.throws(() => verifyRegistryMetadataIntegrity({
      name: '@causyne/agent',
      version: '1.20.121',
      dist: { tarball: 'https://evil.example/agent.tgz' }
    }), /registry\.npmjs\.org/);

    // Reject malformed SRI integrity
    assert.throws(() => verifyRegistryMetadataIntegrity({
      name: '@causyne/agent',
      version: '1.20.121',
      dist: { integrity: 'not-a-valid-sri' }
    }), /malformed SRI integrity/);

    // Reject missing provenance when requireProvenance=true
    assert.throws(() => verifyRegistryMetadataIntegrity({
      name: '@causyne/agent',
      version: '1.20.121',
      dist: { tarball: 'https://registry.npmjs.org/@causyne/agent/-/agent-1.20.121.tgz' }
    }, { requireProvenance: true }), /lacks verified npm provenance/);
  });

  test('checkForUpdate and formatDoctorReport surface provenance, OS Sandbox, and OS Keychain diagnostics', async () => {
    const fetchImpl = (async () => ({
      ok: true,
      json: async () => ({
        name: '@causyne/agent',
        version: '1.20.125',
        dist: {
          tarball: 'https://registry.npmjs.org/@causyne/agent/-/agent-1.20.125.tgz',
          integrity: 'sha512-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB==',
          attestations: {
            url: 'https://registry.npmjs.org/-/npm/v1/attestations/@causyne%2fagent@1.20.125',
            provenance: { predicateType: 'https://slsa.dev/provenance/v1' }
          }
        }
      })
    })) as unknown as typeof fetch;

    const check = await checkForUpdate({ currentVersion: '1.20.120', fetchImpl, requireProvenance: true });
    assert.equal(check.available, true);
    assert.equal(check.provenanceVerified, true);

    const diag = await diagnoseInstallation({ currentVersion: '1.20.120', fetchImpl });
    const report = formatDoctorReport(diag);
    assert.match(report, /Provenance\s+:\s+verified \(npm Sigstore attestation\)/);
    assert.match(report, /OS Sandbox\s+:/);
    assert.match(report, /OS Keychain\s+:/);
  });
});
