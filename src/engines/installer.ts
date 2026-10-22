import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { engineInstallDir } from './registry.js';
import type { NativeEngineAdapter } from './types.js';

const MANIFEST_LIMIT = 1024 * 1024;
const ASSET_LIMIT = 512 * 1024 * 1024;
const DEFAULT_MANIFEST = 'https://github.com/ikbal-causyne/causyne-engines/releases/latest/download/engines.json';

interface EngineAsset {
  url: string;
  sha256: string;
  size?: number;
}

interface EngineRelease {
  version: string;
  license?: string;
  platforms: Record<string, EngineAsset>;
}

interface EngineManifest {
  schema: 1;
  engines: Record<string, EngineRelease>;
}

export interface EngineInstallOptions {
  confirm: boolean;
  signal?: AbortSignal;
}

export interface EngineInstallResult {
  success: boolean;
  engine: string;
  manifestUrl: string;
  requiresConsent?: boolean;
  installed?: boolean;
  alreadyInstalled?: boolean;
  version?: string;
  platform?: string;
  path?: string;
  license?: string;
  size?: number;
  error?: string;
}

export function defaultEngineManifestUrl(): string {
  const override = process.env['CAUSYNE_ENGINE_MANIFEST'];
  return override && override.trim() ? override.trim() : DEFAULT_MANIFEST;
}

function platformKey(): string {
  return `${process.platform}-${process.arch}`;
}

function validVersion(value: string): boolean {
  return /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/.test(value);
}

function validPlatform(value: string): boolean {
  return /^[a-z0-9]+-[a-z0-9]+$/.test(value);
}

function timeoutSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function readLocation(location: string, limit: number, signal?: AbortSignal): Promise<{ text: string; base: string }> {
  if (/^http:/i.test(location)) throw new Error('Engine manifest must use HTTPS or a local file');
  if (/^https:/i.test(location)) {
    const response = await fetch(location, {
      redirect: 'follow',
      headers: { accept: 'application/json', 'user-agent': 'Causyne-Agent' },
      signal: timeoutSignal(20_000, signal)
    });
    if (!response.ok) throw new Error(`Manifest request failed with HTTP ${response.status}`);
    if (new URL(response.url || location).protocol !== 'https:') throw new Error('Engine manifest redirect left HTTPS');
    const text = await response.text();
    if (Buffer.byteLength(text) > limit) throw new Error('Manifest is larger than 1 MB');
    return { text, base: response.url || location };
  }
  const file = location.startsWith('file:') ? fileURLToPath(location) : path.resolve(location);
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > limit) throw new Error('Manifest is missing or larger than 1 MB');
  const text = await fs.readFile(file, 'utf8');
  return { text, base: location.startsWith('file:') ? location : pathToFileURL(file).href };
}

async function readManifest(location: string, signal?: AbortSignal): Promise<{ manifest: EngineManifest; base: string }> {
  const { text, base } = await readLocation(location, MANIFEST_LIMIT, signal);
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('Engine manifest is not valid JSON'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Engine manifest must be an object');
  const record = value as Record<string, unknown>;
  if (record.schema !== 1) throw new Error('Unsupported engine manifest schema');
  if (!record.engines || typeof record.engines !== 'object' || Array.isArray(record.engines)) {
    throw new Error('Engine manifest has no engines map');
  }
  return { manifest: record as unknown as EngineManifest, base };
}

function releaseFor(manifest: EngineManifest, adapter: NativeEngineAdapter): EngineRelease {
  const release = manifest.engines[adapter.id];
  if (!release || typeof release !== 'object') throw new Error(`No release for engine ${adapter.id}`);
  if (typeof release.version !== 'string' || !validVersion(release.version)) throw new Error('Invalid engine release version');
  if (release.license !== undefined && (typeof release.license !== 'string' || release.license.length > 200)) {
    throw new Error('Invalid engine release license');
  }
  if (!release.platforms || typeof release.platforms !== 'object' || Array.isArray(release.platforms)) {
    throw new Error('Engine release has no platform map');
  }
  return release;
}

function assetFor(release: EngineRelease, base: string): { platform: string; asset: EngineAsset; url: string } {
  const platform = platformKey();
  if (!validPlatform(platform)) throw new Error(`Unsupported platform: ${platform}`);
  const asset = release.platforms[platform];
  if (!asset || typeof asset !== 'object') throw new Error(`No release asset for ${platform}`);
  if (typeof asset.url !== 'string' || !asset.url.trim()) throw new Error('Engine asset has no URL');
  if (typeof asset.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(asset.sha256)) throw new Error('Engine asset has no valid SHA-256');
  if (asset.size !== undefined && (!Number.isInteger(asset.size) || asset.size < 1 || asset.size > ASSET_LIMIT)) {
    throw new Error('Engine asset size is invalid');
  }
  const url = new URL(asset.url, base).href;
  const protocol = new URL(url).protocol;
  const localManifest = base.startsWith('file:');
  if (protocol !== 'https:' && !(localManifest && protocol === 'file:')) {
    throw new Error('Engine asset must use HTTPS, or a local file URL from a local manifest');
  }
  return { platform, asset, url };
}

async function assetBytes(url: string, signal?: AbortSignal): Promise<Buffer> {
  if (url.startsWith('file:')) {
    const file = fileURLToPath(url);
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > ASSET_LIMIT) throw new Error('Engine asset is missing or too large');
    return await fs.readFile(file);
  }
  const response = await fetch(url, {
    redirect: 'follow',
    headers: { accept: 'application/octet-stream', 'user-agent': 'Causyne-Agent' },
    signal: timeoutSignal(600_000, signal)
  });
  if (!response.ok) throw new Error(`Engine download failed with HTTP ${response.status}`);
  if (new URL(response.url || url).protocol !== 'https:') throw new Error('Engine download redirect left HTTPS');
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > ASSET_LIMIT) throw new Error('Engine asset is larger than 512 MB');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > ASSET_LIMIT) throw new Error('Engine asset is larger than 512 MB');
  return bytes;
}

async function currentVersion(adapter: NativeEngineAdapter): Promise<{ version: string; platform: string } | null> {
  try {
    const value = JSON.parse(await fs.readFile(path.join(engineInstallDir(adapter), 'current.json'), 'utf8')) as Record<string, unknown>;
    if (typeof value.version !== 'string' || !validVersion(value.version)) return null;
    if (typeof value.platform !== 'string' || !validPlatform(value.platform)) return null;
    return { version: value.version, platform: value.platform };
  } catch {
    return null;
  }
}

export async function installNativeEngine(adapter: NativeEngineAdapter, options: EngineInstallOptions): Promise<EngineInstallResult> {
  const manifestUrl = defaultEngineManifestUrl();
  const base: EngineInstallResult = { success: false, engine: adapter.id, manifestUrl };
  try {
    const { manifest, base: location } = await readManifest(manifestUrl, options.signal);
    const release = releaseFor(manifest, adapter);
    const { platform, asset, url } = assetFor(release, location);
    const root = engineInstallDir(adapter);
    const suffix = process.platform === 'win32' ? '.exe' : '';
    const target = path.join(root, 'versions', release.version, platform, `${adapter.binaryName}${suffix}`);
    const current = await currentVersion(adapter);
    if (current?.version === release.version && current.platform === platform) {
      try {
        await fs.access(target, fs.constants.X_OK);
        return {
          ...base,
          success: true,
          installed: true,
          alreadyInstalled: true,
          version: release.version,
          platform,
          path: target,
          ...(release.license ? { license: release.license } : {}),
          ...(asset.size ? { size: asset.size } : {})
        };
      } catch { /* stale pointer: reinstall below */ }
    }
    const details = {
      ...base,
      version: release.version,
      platform,
      ...(release.license ? { license: release.license } : {}),
      ...(asset.size ? { size: asset.size } : {})
    };
    if (!options.confirm) return { ...details, requiresConsent: true };

    const bytes = await assetBytes(url, options.signal);
    if (asset.size && bytes.length !== asset.size) throw new Error('Engine asset size does not match the manifest');
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest.toLowerCase() !== asset.sha256.toLowerCase()) throw new Error('Engine asset SHA-256 does not match the manifest');

    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temp = path.join(path.dirname(target), `.${path.basename(target)}.download-${process.pid}-${Date.now()}`);
    try {
      await fs.writeFile(temp, bytes, { mode: 0o600 });
      await fs.chmod(temp, 0o755);
      await fs.rm(target, { force: true });
      await fs.rename(temp, target);
    } catch (error) {
      await fs.rm(temp, { force: true }).catch(() => {});
      throw error;
    }

    const pointer = path.join(root, 'current.json');
    const pointerTemp = `${pointer}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(pointerTemp, JSON.stringify({
      engine: adapter.id,
      version: release.version,
      platform,
      sha256: asset.sha256.toLowerCase(),
      installedAt: new Date().toISOString()
    }), { mode: 0o600 });
    try {
      await fs.rename(pointerTemp, pointer);
    } catch (error) {
      await fs.rm(pointerTemp, { force: true }).catch(() => {});
      throw error;
    }

    return {
      ...details,
      success: true,
      installed: true,
      alreadyInstalled: false,
      path: target
    };
  } catch (error) {
    return { ...base, error: error instanceof Error ? error.message : String(error) };
  }
}
