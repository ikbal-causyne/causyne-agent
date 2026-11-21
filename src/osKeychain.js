/**
 * Causyne Agent — Optional OS Keychain Master-Key Backend (Sector 6C)
 *
 * Stores and retrieves the 32-byte AES-256-GCM vault master key in the host
 * operating system's credential store when enabled via `CAUSYNE_KEYCHAIN=on|auto|strict`:
 *   - macOS (`darwin`):  Keychain Services (`/usr/bin/security -i` via stdin, never argv)
 *   - Linux (`linux`):   libsecret (`secret-tool` via stdin, never argv)
 *   - Windows (`win32`): DPAPI `CurrentUser` encrypted blob (`.vault_key.dpapi` via stdin)
 *
 * Defaults to `'off'` so headless CI runners, containers, and existing `.vault_key`
 * users experience zero unexpected OS prompts.
 */
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
const KEYCHAIN_SERVICE = 'causyne-agent';
const EXPECTED_KEY_BYTES = 32;
const EXPECTED_KEY_HEX_LEN = EXPECTED_KEY_BYTES * 2;
const MACOS_SECURITY_BIN = '/usr/bin/security';
export function resolveKeychainMode(env = process.env) {
    const raw = typeof env.CAUSYNE_KEYCHAIN === 'string' ? env.CAUSYNE_KEYCHAIN.trim().toLowerCase() : '';
    if (raw === 'strict')
        return 'strict';
    if (raw === 'on' || raw === '1' || raw === 'true')
        return 'on';
    if (raw === 'auto')
        return 'auto';
    return 'off';
}
export function keychainAccountForVaultDir(vaultDir) {
    const digest = crypto.createHash('sha256').update(path.resolve(vaultDir)).digest('hex').slice(0, 12);
    return `vault-key-${digest}`;
}
function isValidHexKey(raw) {
    return raw.length === EXPECTED_KEY_HEX_LEN && /^[0-9a-fA-F]+$/.test(raw);
}
function findInPath(binary, env = process.env) {
    const pathVal = env.PATH || env.Path || '';
    for (const dir of pathVal.split(path.delimiter)) {
        if (!dir)
            continue;
        const full = path.join(dir, binary);
        try {
            fs.accessSync(full, fs.constants.X_OK);
            if (fs.statSync(full).isFile())
                return full;
        }
        catch {
            continue;
        }
    }
    return null;
}
export function probeOsKeychain(options = {}) {
    const platform = options.platform ?? process.platform;
    const env = options.env ?? process.env;
    if (platform === 'darwin') {
        const exists = fs.existsSync(MACOS_SECURITY_BIN);
        return {
            backend: exists ? 'macos-keychain' : 'none',
            platform,
            available: exists,
            reason: exists ? 'macOS Keychain Services (/usr/bin/security) available.' : 'macOS security CLI not found.'
        };
    }
    if (platform === 'linux') {
        const secretTool = findInPath('secret-tool', env);
        return {
            backend: secretTool ? 'linux-secret-service' : 'none',
            platform,
            available: Boolean(secretTool),
            reason: secretTool ? 'Linux Secret Service (secret-tool) available.' : 'secret-tool not installed.'
        };
    }
    if (platform === 'win32') {
        return {
            backend: 'windows-dpapi',
            platform,
            available: true,
            reason: 'Windows DPAPI (CurrentUser scope) available.'
        };
    }
    return {
        backend: 'none',
        platform,
        available: false,
        reason: `No OS keychain backend implemented for platform "${platform}".`
    };
}
function dpapiBlobPath(vaultDir) {
    return path.join(path.resolve(vaultDir), '.vault_key.dpapi');
}
/**
 * Loads the 32-byte vault key from the OS credential store, or returns `null` if absent/unavailable.
 */
const SAFE_ACCOUNT_PATTERN = /^vault-key-[0-9a-f]{12}$/;
export function loadVaultKeyFromKeychain(vaultDir, options = {}) {
    if (typeof vaultDir !== 'string' || !vaultDir.trim() || vaultDir.includes('\0'))
        return null;
    const platform = options.platform ?? process.platform;
    const runner = options.spawnSyncImpl ?? spawnSync;
    const account = keychainAccountForVaultDir(vaultDir);
    if (platform === 'darwin') {
        const res = runner(MACOS_SECURITY_BIN, ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', account, '-w'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 5000,
            maxBuffer: 1024 * 1024,
            windowsHide: true,
            shell: false
        });
        if (!res || res.error || res.status !== 0 || typeof res.stdout !== 'string')
            return null;
        const hex = res.stdout.trim();
        return isValidHexKey(hex) ? Buffer.from(hex, 'hex') : null;
    }
    if (platform === 'linux') {
        const res = runner('secret-tool', ['lookup', 'service', KEYCHAIN_SERVICE, 'account', account], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 5000,
            maxBuffer: 1024 * 1024,
            windowsHide: true,
            shell: false
        });
        if (res.status !== 0 || typeof res.stdout !== 'string')
            return null;
        const hex = res.stdout.trim();
        return isValidHexKey(hex) ? Buffer.from(hex, 'hex') : null;
    }
    if (platform === 'win32') {
        const blobFile = dpapiBlobPath(vaultDir);
        if (!fs.existsSync(blobFile))
            return null;
        try {
            const stat = fs.lstatSync(blobFile);
            if (stat.isSymbolicLink() || !stat.isFile() || stat.size === 0 || stat.size > 65_536)
                return null;
        }
        catch {
            return null;
        }
        const protectedBase64 = fs.readFileSync(blobFile, 'utf8').trim();
        if (!protectedBase64 || !/^[A-Za-z0-9+/=]+$/.test(protectedBase64))
            return null;
        const script = [
            'Add-Type -AssemblyName System.Security',
            '$b64 = [Console]::In.ReadToEnd().Trim()',
            '$enc = [Convert]::FromBase64String($b64)',
            '$plain = [System.Security.Cryptography.ProtectedData]::Unprotect($enc, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
            '[Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($plain))'
        ].join('; ');
        const res = runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
            input: protectedBase64,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 8000,
            maxBuffer: 1024 * 1024,
            windowsHide: true,
            shell: false
        });
        if (res.status !== 0 || typeof res.stdout !== 'string')
            return null;
        const hex = res.stdout.trim();
        return isValidHexKey(hex) ? Buffer.from(hex, 'hex') : null;
    }
    return null;
}
/**
 * Persists a 32-byte vault key into the OS credential store without passing
 * secret material on command-line argv (always delivered via stdin).
 */
export function saveVaultKeyToKeychain(vaultDir, key, options = {}) {
    if (typeof vaultDir !== 'string' || !vaultDir.trim() || vaultDir.includes('\0'))
        return false;
    if (!Buffer.isBuffer(key) || key.length !== EXPECTED_KEY_BYTES)
        return false;
    const platform = options.platform ?? process.platform;
    const runner = options.spawnSyncImpl ?? spawnSync;
    const account = keychainAccountForVaultDir(vaultDir);
    const hexKey = key.toString('hex');
    if (!SAFE_ACCOUNT_PATTERN.test(account) || !isValidHexKey(hexKey))
        return false;
    if (platform === 'darwin') {
        // Use interactive `-i` stdin mode so the hex key never appears in process argv (`ps`)
        const stdinCmd = `add-generic-password -U -s "${KEYCHAIN_SERVICE}" -a "${account}" -w "${hexKey}"\n`;
        const res = runner(MACOS_SECURITY_BIN, ['-i'], {
            input: stdinCmd,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 5000,
            maxBuffer: 1024 * 1024,
            windowsHide: true,
            shell: false
        });
        return Boolean(res && !res.error && res.status === 0);
    }
    if (platform === 'linux') {
        const res = runner('secret-tool', ['store', '--label', 'Causyne Agent Vault Key', 'service', KEYCHAIN_SERVICE, 'account', account], {
            input: hexKey,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 5000,
            maxBuffer: 1024 * 1024,
            windowsHide: true,
            shell: false
        });
        return Boolean(res && !res.error && res.status === 0);
    }
    if (platform === 'win32') {
        const script = [
            'Add-Type -AssemblyName System.Security',
            '$hex = [Console]::In.ReadToEnd().Trim()',
            '$bytes = [System.Text.Encoding]::UTF8.GetBytes($hex)',
            '$enc = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)',
            '[Console]::Out.Write([Convert]::ToBase64String($enc))'
        ].join('; ');
        const res = runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
            input: hexKey,
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 8000,
            maxBuffer: 1024 * 1024,
            windowsHide: true,
            shell: false
        });
        if (res.status !== 0 || typeof res.stdout !== 'string' || !res.stdout.trim())
            return false;
        const blobFile = dpapiBlobPath(vaultDir);
        const dir = path.dirname(blobFile);
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        try {
            const existing = fs.lstatSync(blobFile);
            if (existing.isSymbolicLink() || !existing.isFile())
                return false;
        }
        catch (err) {
            const code = typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : '';
            if (code !== 'ENOENT')
                return false;
        }
        const tempFile = path.join(dir, `.vault_key.dpapi.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
        try {
            fs.writeFileSync(tempFile, `${res.stdout.trim()}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
            fs.renameSync(tempFile, blobFile);
        }
        catch {
            try {
                if (fs.existsSync(tempFile))
                    fs.unlinkSync(tempFile);
            }
            catch { /* ignore */ }
            return false;
        }
        return true;
    }
    return false;
}
