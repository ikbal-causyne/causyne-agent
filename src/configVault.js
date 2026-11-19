/**
 * Causyne Agent — Atomic Config Vault & AES-256-GCM Secret Protection
 *
 * Hardens local BYOK credential storage (`~/.causyne/config.json` & `.vault_key`):
 * 1. Atomic write-temp-chmod-rename (`atomicWriteSecretFileSync`) to prevent
 *    truncated/corrupted config files on crash or concurrent writes.
 * 2. Strict `0o700` vault directory and `0o600` secret file permissions on POSIX.
 * 3. NIST SP 800-38D standard 12-byte (96-bit) IV for new AES-256-GCM ciphertexts,
 *    while preserving full decryption compatibility with legacy 16-byte IV records.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
export const VAULT_KEY_BYTES = 32;
export const VAULT_GCM_IV_BYTES = 12;
export const VAULT_LEGACY_GCM_IV_BYTES = 16;
export const VAULT_GCM_AUTH_TAG_BYTES = 16;
export const VAULT_ENC_PREFIX = 'ENC:';
export function isEncryptedVaultSecret(value) {
    return typeof value === 'string' && value.startsWith(VAULT_ENC_PREFIX);
}
export function ensureVaultDir(dir) {
    const resolved = path.resolve(dir);
    if (!fs.existsSync(resolved)) {
        fs.mkdirSync(resolved, { recursive: true, mode: 0o700 });
    }
    if (process.platform !== 'win32') {
        try {
            fs.chmodSync(resolved, 0o700);
        }
        catch {
            // Best-effort permission tightening on platforms that restrict chmod
        }
    }
}
/**
 * Atomically writes a secret-bearing file (`config.json` or `.vault_key`) using
 * a unique sibling temporary file with mode `0o600` followed by atomic rename.
 */
export function atomicWriteSecretFileSync(targetPath, content) {
    const resolved = path.resolve(targetPath);
    const dir = path.dirname(resolved);
    ensureVaultDir(dir);
    const suffix = `${process.pid}.${crypto.randomBytes(6).toString('hex')}`;
    const tempPath = path.join(dir, `.${path.basename(resolved)}.${suffix}.tmp`);
    try {
        if (typeof content === 'string') {
            fs.writeFileSync(tempPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        }
        else {
            fs.writeFileSync(tempPath, content, { mode: 0o600, flag: 'wx' });
        }
        if (process.platform !== 'win32') {
            try {
                fs.chmodSync(tempPath, 0o600);
            }
            catch {
                // Ignore chmod errors on non-POSIX mounts
            }
        }
        fs.renameSync(tempPath, resolved);
        if (process.platform !== 'win32') {
            try {
                fs.chmodSync(resolved, 0o600);
            }
            catch {
                // Ignore chmod errors on non-POSIX mounts
            }
        }
    }
    catch (err) {
        try {
            if (fs.existsSync(tempPath))
                fs.unlinkSync(tempPath);
        }
        catch {
            // Ignore temp cleanup failure
        }
        throw err;
    }
}
/**
 * Loads or atomically initializes the 256-bit local vault key with `0o600` permissions.
 */
export function getOrCreateVaultKey(keyFilePath) {
    const resolved = path.resolve(keyFilePath);
    ensureVaultDir(path.dirname(resolved));
    if (fs.existsSync(resolved)) {
        if (process.platform !== 'win32') {
            try {
                fs.chmodSync(resolved, 0o600);
            }
            catch {
                // Ignore chmod errors on non-POSIX mounts
            }
        }
        const existing = fs.readFileSync(resolved);
        if (existing.length !== VAULT_KEY_BYTES) {
            throw new Error(`Invalid vault key length (${existing.length} bytes; expected ${VAULT_KEY_BYTES}).`);
        }
        return existing;
    }
    const freshKey = crypto.randomBytes(VAULT_KEY_BYTES);
    try {
        // Exclusive create first so concurrent startups do not clobber each other's key
        fs.writeFileSync(resolved, freshKey, { mode: 0o600, flag: 'wx' });
        if (process.platform !== 'win32') {
            try {
                fs.chmodSync(resolved, 0o600);
            }
            catch {
                // Ignore chmod errors
            }
        }
        return freshKey;
    }
    catch (err) {
        const code = typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : '';
        if (code === 'EEXIST') {
            const raced = fs.readFileSync(resolved);
            if (raced.length === VAULT_KEY_BYTES)
                return raced;
        }
        throw err;
    }
}
/**
 * Encrypts a plaintext secret using AES-256-GCM with a NIST-standard 12-byte IV.
 */
export function encryptVaultSecret(text, keyFilePath) {
    if (!text)
        return text;
    if (isEncryptedVaultSecret(text))
        return text;
    const key = getOrCreateVaultKey(keyFilePath);
    const iv = crypto.randomBytes(VAULT_GCM_IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag().toString('hex');
    return `${VAULT_ENC_PREFIX}${iv.toString('hex')}:${authTag}:${encrypted}`;
}
/**
 * Decrypts an `ENC:` secret produced with either the standard 12-byte GCM IV
 * or legacy 16-byte GCM IV. Returns empty string on authentication failure.
 */
export function decryptVaultSecret(encryptedText, keyFilePath) {
    if (!encryptedText || !isEncryptedVaultSecret(encryptedText))
        return encryptedText;
    try {
        const parts = encryptedText.split(':');
        if (parts.length !== 4)
            return '';
        const ivHex = parts[1] ?? '';
        const authTagHex = parts[2] ?? '';
        const ciphertextHex = parts[3] ?? '';
        const iv = Buffer.from(ivHex, 'hex');
        const authTag = Buffer.from(authTagHex, 'hex');
        if ((iv.length !== VAULT_GCM_IV_BYTES && iv.length !== VAULT_LEGACY_GCM_IV_BYTES) ||
            authTag.length !== VAULT_GCM_AUTH_TAG_BYTES) {
            return '';
        }
        const key = getOrCreateVaultKey(keyFilePath);
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(authTag);
        let decrypted = decipher.update(ciphertextHex, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
    }
    catch {
        return '';
    }
}
