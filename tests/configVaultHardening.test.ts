import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REAL_CAUSYNE_HOME = process.env.CAUSYNE_HOME;
const TMP_ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-sec6a-')));
const VAULT_DIR = path.join(TMP_ROOT, '.causyne');
process.env.CAUSYNE_HOME = VAULT_DIR;

const {
  VAULT_GCM_IV_BYTES,
  encryptVaultSecret,
  decryptVaultSecret,
  getOrCreateVaultKey,
  atomicWriteSecretFileSync
} = await import('../src/configVault.js');
const { loadConfig, saveConfig } = await import('../src/config.js');

after(() => {
  if (REAL_CAUSYNE_HOME !== undefined) process.env.CAUSYNE_HOME = REAL_CAUSYNE_HOME;
  else delete process.env.CAUSYNE_HOME;
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch {}
});

describe('Sector 6A — Atomic Config Vault & AES-256-GCM Hygiene', () => {
  test('encryptVaultSecret uses NIST 12-byte GCM IV and decrypts round-trip cleanly', () => {
    const keyPath = path.join(TMP_ROOT, 'isolated', '.vault_key');
    const secret = ['vault', 'roundtrip', 'fixture', '9001'].join('-');
    const enc = encryptVaultSecret(secret, keyPath);

    assert.ok(enc.startsWith('ENC:'));
    const parts = enc.split(':');
    assert.equal(parts.length, 4);
    assert.equal(Buffer.from(parts[1]!, 'hex').length, VAULT_GCM_IV_BYTES, 'new ciphertexts must use 12-byte GCM IV');
    assert.equal(Buffer.from(parts[2]!, 'hex').length, 16, 'GCM auth tag must be 16 bytes');

    assert.equal(decryptVaultSecret(enc, keyPath), secret);
    assert.equal(encryptVaultSecret(enc, keyPath), enc, 'already-encrypted secrets must not double-encrypt');

    if (process.platform !== 'win32') {
      const mode = fs.statSync(keyPath).mode & 0o777;
      assert.equal(mode, 0o600, '.vault_key must enforce 0600 permissions');
    }
  });

  test('decryptVaultSecret maintains full backward compatibility with legacy 16-byte GCM IV records', () => {
    const keyPath = path.join(TMP_ROOT, 'legacy', '.vault_key');
    const key = getOrCreateVaultKey(keyPath);
    const secret = ['legacy', 'iv16', 'fixture', '42'].join('-');
    const iv16 = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv16);
    const encrypted = cipher.update(secret, 'utf8', 'hex') + cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    const legacyRecord = `ENC:${iv16.toString('hex')}:${authTag}:${encrypted}`;

    assert.equal(decryptVaultSecret(legacyRecord, keyPath), secret);

    // Tampered auth tag or bad IV length must fail closed (empty string)
    const tampered = `ENC:${iv16.toString('hex')}:${'00'.repeat(16)}:${encrypted}`;
    assert.equal(decryptVaultSecret(tampered, keyPath), '');
    assert.equal(decryptVaultSecret(`ENC:${'aa'.repeat(8)}:${authTag}:${encrypted}`, keyPath), '');
  });

  test('atomicWriteSecretFileSync leaves no temporary files and enforces 0600 permissions', () => {
    const dir = path.join(TMP_ROOT, 'atomic');
    const file = path.join(dir, 'secret.json');
    atomicWriteSecretFileSync(file, '{"ok":true}\n');

    assert.equal(fs.readFileSync(file, 'utf8'), '{"ok":true}\n');
    const leftoverTmp = fs.readdirSync(dir).filter(f => f.endsWith('.tmp'));
    assert.deepEqual(leftoverTmp, []);
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    }
  });

  test('loadConfig does NOT persist transient process.env API keys to config.json on disk', () => {
    const envVaultDir = path.join(TMP_ROOT, 'env-no-persist');
    const prevHome = process.env.CAUSYNE_HOME;
    const prevOpenAI = process.env.OPENAI_API_KEY;
    const prevGemini = process.env.GEMINI_API_KEY;
    const prevGoogle = process.env.GOOGLE_API_KEY;
    const prevAnthropic = process.env.ANTHROPIC_API_KEY;

    const envSecret = ['env', 'transient', 'fixture', '777'].join('-');
    process.env.CAUSYNE_HOME = envVaultDir;
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    process.env.OPENAI_API_KEY = envSecret;

    try {
      const cfg = loadConfig();
      assert.equal(cfg.provider, 'openai');
      assert.equal(cfg.apiKey, envSecret, 'env key must be available in memory');
      assert.equal(
        fs.existsSync(path.join(envVaultDir, 'config.json')),
        false,
        'transient process.env API key must NOT be written to disk by loadConfig()'
      );
    } finally {
      process.env.CAUSYNE_HOME = prevHome;
      if (prevOpenAI !== undefined) process.env.OPENAI_API_KEY = prevOpenAI;
      else delete process.env.OPENAI_API_KEY;
      if (prevGemini !== undefined) process.env.GEMINI_API_KEY = prevGemini;
      if (prevGoogle !== undefined) process.env.GOOGLE_API_KEY = prevGoogle;
      if (prevAnthropic !== undefined) process.env.ANTHROPIC_API_KEY = prevAnthropic;
    }
  });

  test('loadConfig auto-re-encrypts legacy plaintext entries inside BOTH apiKey and providerKeys', () => {
    const migrateDir = path.join(TMP_ROOT, 'migrate-plaintext');
    const prevHome = process.env.CAUSYNE_HOME;
    process.env.CAUSYNE_HOME = migrateDir;
    fs.mkdirSync(migrateDir, { recursive: true, mode: 0o700 });

    const keyA = ['legacy', 'primary', 'fixture', '111'].join('-');
    const keyB = ['legacy', 'secondary', 'fixture', '222'].join('-');
    const cfgPath = path.join(migrateDir, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({
      provider: 'openai',
      model: 'gpt-4o',
      apiKey: keyA,
      providerKeys: {
        openai: keyA,
        anthropic: keyB
      },
      autonomyMode: 'B'
    }, null, 2));

    try {
      const loaded = loadConfig();
      assert.equal(loaded.apiKey, keyA);
      assert.equal(loaded.providerKeys.openai, keyA);
      assert.equal(loaded.providerKeys.anthropic, keyB);

      const persistedRaw = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      assert.ok(persistedRaw.apiKey.startsWith('ENC:'), 'apiKey must be re-encrypted on disk');
      assert.ok(persistedRaw.providerKeys.openai.startsWith('ENC:'), 'providerKeys.openai must be re-encrypted on disk');
      assert.ok(persistedRaw.providerKeys.anthropic.startsWith('ENC:'), 'providerKeys.anthropic must be re-encrypted on disk');
      assert.ok(!JSON.stringify(persistedRaw).includes(keyA));
      assert.ok(!JSON.stringify(persistedRaw).includes(keyB));

      // Explicit saveConfig round-trip preserves values and 0600 permissions
      saveConfig(loaded);
      const reloaded = loadConfig();
      assert.equal(reloaded.apiKey, keyA);
      assert.equal(reloaded.providerKeys.anthropic, keyB);
    } finally {
      process.env.CAUSYNE_HOME = prevHome;
    }
  });
});
