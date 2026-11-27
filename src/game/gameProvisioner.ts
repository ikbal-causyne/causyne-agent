/**
 * Manifest-driven locator and HTTPS + SHA-256 verified auto-provisioner for
 * Causyne Game (official separate AI Game Studio workspace).
 *
 * Mirrors the security guarantees of `src/engines/installer.ts`:
 * - Explicit consent gate (`confirm: true`) before downloading/extracting.
 * - Public HTTPS-only downloads (or `file://` for explicitly supplied local manifests).
 * - Strict byte limits, redirect hop caps, SHA-256 verification before extraction.
 * - Atomic versioned installs under `~/.causyne/game/versions/<version>/` + `current.json`.
 * - Zero shell interpolation and zero hidden background daemons.
 */

import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertPublicWebUrl } from '../browser/urlPolicy.js';
import { causyneHome } from '../utils/paths.js';

const execFileAsync = promisify(execFile);

const MANIFEST_LIMIT = 1024 * 1024;
const ARCHIVE_LIMIT = 512 * 1024 * 1024;
const DEFAULT_GAME_MANIFEST = 'https://github.com/ikbal-causyne/causyne-game/releases/latest/download/causyne-game.json';

export type GameInstallSource = 'explicit' | 'env' | 'managed' | 'sibling';

export interface LocatedGameStudio {
  dir: string;
  serverEntry: string;
  packageJson: string;
  source: GameInstallSource;
  version?: string | undefined;
  hasStudioBuild: boolean;
  hasNodeModules: boolean;
}

export interface GameManifestArchive {
  url: string;
  sha256: string;
  size?: number | undefined;
  format?: 'tar.gz' | undefined;
}

export interface GameStudioManifest {
  schema: 1;
  product: 'causyne-game';
  version: string;
  license?: string | undefined;
  archive: GameManifestArchive;
}

export interface InstallGameStudioOptions {
  confirm: boolean;
  manifestUrl?: string | undefined;
  signal?: AbortSignal | undefined;
}

export interface InstallGameStudioResult {
  success: boolean;
  manifestUrl: string;
  requiresConsent?: boolean | undefined;
  installed?: boolean | undefined;
  alreadyInstalled?: boolean | undefined;
  version?: string | undefined;
  license?: string | undefined;
  size?: number | undefined;
  path?: string | undefined;
  error?: string | undefined;
}

export function defaultGameManifestUrl(): string {
  const override = process.env['CAUSYNE_GAME_MANIFEST'];
  return override && override.trim() ? override.trim() : DEFAULT_GAME_MANIFEST;
}

export function gameInstallRoot(): string {
  return path.join(causyneHome(), 'game');
}

export function gameDataDir(): string {
  const override = process.env['CAUSYNE_GAME_DATA_DIR'];
  if (override && override.trim()) return path.resolve(override.trim());
  return path.join(causyneHome(), 'game-data');
}

function validVersion(value: string): boolean {
  return /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/.test(value);
}

function packageRootDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..');
}

function readPackageVersionSync(pkgPath: string): string | undefined {
  try {
    const raw = JSON.parse(fsSync.readFileSync(pkgPath, 'utf8')) as Record<string, unknown>;
    return typeof raw.version === 'string' && raw.version.trim() ? raw.version.trim() : undefined;
  } catch {
    return undefined;
  }
}

function inspectCandidateDir(dir: string, source: GameInstallSource): LocatedGameStudio | null {
  if (!dir || dir.includes('\0')) return null;
  const resolved = path.resolve(dir);
  const serverEntry = path.join(resolved, 'server.ts');
  const packageJson = path.join(resolved, 'package.json');
  try {
    if (!fsSync.statSync(resolved).isDirectory()) return null;
    if (!fsSync.statSync(serverEntry).isFile()) return null;
    if (!fsSync.statSync(packageJson).isFile()) return null;
  } catch {
    return null;
  }
  const hasStudioBuild =
    fsSync.existsSync(path.join(resolved, 'studio', 'build', 'index.html'))
    || fsSync.existsSync(path.join(resolved, 'build', 'index.html'));
  const hasNodeModules = fsSync.existsSync(path.join(resolved, 'node_modules'));
  const version = readPackageVersionSync(packageJson);
  return {
    dir: resolved,
    serverEntry,
    packageJson,
    source,
    ...(version ? { version } : {}),
    hasStudioBuild,
    hasNodeModules
  };
}

function readManagedCurrentPointer(): { version: string; dir: string } | null {
  const root = gameInstallRoot();
  const pointerFile = path.join(root, 'current.json');
  try {
    const parsed = JSON.parse(fsSync.readFileSync(pointerFile, 'utf8')) as Record<string, unknown>;
    if (typeof parsed.version !== 'string' || !validVersion(parsed.version)) return null;
    const versionsRoot = path.resolve(root, 'versions');
    const target = path.resolve(versionsRoot, parsed.version);
    const relative = path.relative(versionsRoot, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
    return { version: parsed.version, dir: target };
  } catch {
    return null;
  }
}

/**
 * Locate an installed Causyne Game workspace in priority order:
 * 1. Explicit `--dir` argument
 * 2. `CAUSYNE_GAME_DIR` environment override
 * 3. Managed installation under `~/.causyne/game/current.json`
 * 4. Sibling workspace checkout (`../causyne-game`)
 */
export function locateGameStudio(explicitDir?: string): LocatedGameStudio | null {
  if (explicitDir && explicitDir.trim()) {
    return inspectCandidateDir(explicitDir.trim(), 'explicit');
  }

  const envDir = process.env['CAUSYNE_GAME_DIR'];
  if (envDir && envDir.trim()) {
    const found = inspectCandidateDir(envDir.trim(), 'env');
    if (found) return found;
  }

  const managed = readManagedCurrentPointer();
  if (managed) {
    const found = inspectCandidateDir(managed.dir, 'managed');
    if (found) return found;
  }

  const sibling = path.resolve(packageRootDir(), '..', 'causyne-game');
  return inspectCandidateDir(sibling, 'sibling');
}

function timeoutSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function fetchHttpsBounded(
  initialUrl: string,
  headers: Record<string, string>,
  limit: number,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<{ buffer: Buffer; finalUrl: string }> {
  let current = initialUrl;
  for (let hops = 0; hops < 6; hops++) {
    const verified = await assertPublicWebUrl(current);
    if (verified.protocol !== 'https:') throw new Error('Causyne Game download must remain on HTTPS');
    const response = await fetch(verified.href, {
      redirect: 'manual',
      headers,
      signal: timeoutSignal(timeoutMs, signal)
    });
    if (response.status >= 300 && response.status < 400) {
      const loc = response.headers.get('location');
      if (!loc) throw new Error(`Causyne Game download redirect missing Location header (HTTP ${response.status})`);
      current = new URL(loc, verified).href;
      continue;
    }
    if (!response.ok) throw new Error(`Request failed with HTTP ${response.status}`);
    const declared = Number(response.headers.get('content-length') || 0);
    if (Number.isFinite(declared) && declared > limit) {
      throw new Error(`Response exceeds maximum allowed size (${limit} bytes)`);
    }
    if (!response.body) {
      const ab = await response.arrayBuffer();
      if (ab.byteLength > limit) throw new Error(`Response exceeds maximum allowed size (${limit} bytes)`);
      return { buffer: Buffer.from(ab), finalUrl: verified.href };
    }
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          total += value.byteLength;
          if (total > limit) {
            await reader.cancel().catch(() => {});
            throw new Error(`Response exceeds maximum allowed size (${limit} bytes)`);
          }
          chunks.push(Buffer.from(value));
        }
      }
    } finally {
      reader.releaseLock();
    }
    return { buffer: Buffer.concat(chunks, total), finalUrl: verified.href };
  }
  throw new Error('Causyne Game download exceeded maximum redirect hops');
}

async function readManifestLocation(location: string, signal?: AbortSignal): Promise<{ text: string; base: string }> {
  if (/^http:/i.test(location)) throw new Error('Causyne Game manifest must use HTTPS or a local file');
  if (/^https:/i.test(location)) {
    const { buffer, finalUrl } = await fetchHttpsBounded(
      location,
      { accept: 'application/json', 'user-agent': 'Causyne-Agent' },
      MANIFEST_LIMIT,
      20_000,
      signal
    );
    return { text: buffer.toString('utf8'), base: finalUrl };
  }
  const file = location.startsWith('file:') ? fileURLToPath(location) : path.resolve(location);
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > MANIFEST_LIMIT) throw new Error('Manifest is missing or larger than 1 MB');
  const text = await fs.readFile(file, 'utf8');
  return { text, base: location.startsWith('file:') ? location : pathToFileURL(file).href };
}

async function parseGameManifest(location: string, signal?: AbortSignal): Promise<{ manifest: GameStudioManifest; base: string }> {
  const { text, base } = await readManifestLocation(location, signal);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Causyne Game manifest is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Causyne Game manifest must be a JSON object');
  }
  const rec = parsed as Record<string, unknown>;
  if (rec.schema !== 1) throw new Error('Unsupported Causyne Game manifest schema');
  if (rec.product !== 'causyne-game') throw new Error('Manifest product must be "causyne-game"');
  if (typeof rec.version !== 'string' || !validVersion(rec.version)) {
    throw new Error('Invalid Causyne Game release version');
  }
  if (rec.license !== undefined && (typeof rec.license !== 'string' || rec.license.length > 200)) {
    throw new Error('Invalid Causyne Game release license');
  }
  if (!rec.archive || typeof rec.archive !== 'object' || Array.isArray(rec.archive)) {
    throw new Error('Causyne Game manifest has no archive descriptor');
  }
  const arch = rec.archive as Record<string, unknown>;
  if (typeof arch.url !== 'string' || !arch.url.trim()) throw new Error('Causyne Game archive has no URL');
  if (typeof arch.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(arch.sha256)) {
    throw new Error('Causyne Game archive has no valid SHA-256 digest');
  }
  if (arch.size !== undefined && (!Number.isInteger(arch.size) || (arch.size as number) < 1 || (arch.size as number) > ARCHIVE_LIMIT)) {
    throw new Error('Causyne Game archive size is invalid');
  }
  if (arch.format !== undefined && arch.format !== 'tar.gz') {
    throw new Error('Unsupported Causyne Game archive format (expected tar.gz)');
  }
  return {
    manifest: {
      schema: 1,
      product: 'causyne-game',
      version: rec.version,
      ...(typeof rec.license === 'string' ? { license: rec.license } : {}),
      archive: {
        url: arch.url.trim(),
        sha256: arch.sha256.toLowerCase(),
        ...(typeof arch.size === 'number' ? { size: arch.size } : {}),
        format: 'tar.gz'
      }
    },
    base
  };
}

async function readArchiveBytes(url: string, base: string, signal?: AbortSignal): Promise<Buffer> {
  const resolved = new URL(url, base).href;
  const protocol = new URL(resolved).protocol;
  const localManifest = base.startsWith('file:');
  if (protocol !== 'https:' && !(localManifest && protocol === 'file:')) {
    throw new Error('Causyne Game archive must use HTTPS, or a local file URL from a local manifest');
  }
  if (protocol === 'file:') {
    const file = fileURLToPath(resolved);
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > ARCHIVE_LIMIT) throw new Error('Causyne Game archive is missing or too large');
    return await fs.readFile(file);
  }
  const { buffer } = await fetchHttpsBounded(
    resolved,
    { accept: 'application/octet-stream', 'user-agent': 'Causyne-Agent' },
    ARCHIVE_LIMIT,
    600_000,
    signal
  );
  return buffer;
}

function resolveTarExecutable(): string {
  if (process.platform === 'win32') {
    const sysRoot = process.env['SystemRoot'] || 'C:\\Windows';
    const winTar = path.join(sysRoot, 'System32', 'tar.exe');
    if (fsSync.existsSync(winTar)) return winTar;
  }
  return 'tar';
}

async function verifyTarSafety(archivePath: string): Promise<void> {
  const { stdout } = await execFileAsync(resolveTarExecutable(), ['-tzf', path.basename(archivePath)], {
    cwd: path.dirname(archivePath),
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true
  });
  const entries = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (entries.length === 0) throw new Error('Causyne Game archive is empty');
  for (const entry of entries) {
    if (entry.startsWith('/') || entry.startsWith('\\') || /^[a-zA-Z]:/.test(entry)) {
      throw new Error(`Refusing archive with absolute path entry: ${entry}`);
    }
    const normalized = path.posix.normalize(entry.replace(/\\/g, '/'));
    if (normalized === '..' || normalized.startsWith('../')) {
      throw new Error(`Refusing archive with path traversal entry: ${entry}`);
    }
  }
}

async function resolveExtractedRoot(stageDir: string): Promise<string> {
  if (inspectCandidateDir(stageDir, 'managed')) return stageDir;
  const children = await fs.readdir(stageDir, { withFileTypes: true });
  const dirs = children.filter((item) => item.isDirectory());
  if (dirs.length === 1 && dirs[0]) {
    const nested = path.join(stageDir, dirs[0].name);
    if (inspectCandidateDir(nested, 'managed')) return nested;
  }
  throw new Error('Extracted archive does not contain a valid Causyne Game runtime (missing server.ts or package.json)');
}

async function assertNoEscapingSymlinks(rootDir: string): Promise<void> {
  const realRoot = await fs.realpath(rootDir);
  const stack = [realRoot];
  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        const target = await fs.realpath(full);
        const rel = path.relative(realRoot, target);
        if (rel.startsWith('..') || path.isAbsolute(rel)) {
          throw new Error(`Refusing archive with symlink escaping install root: ${entry.name}`);
        }
      } else if (entry.isDirectory()) {
        stack.push(full);
      }
    }
  }
}

/**
 * Download, SHA-256 verify, and atomically install Causyne Game into `~/.causyne/game/`.
 */
export async function installGameStudio(options: InstallGameStudioOptions): Promise<InstallGameStudioResult> {
  const manifestUrl = options.manifestUrl?.trim() || defaultGameManifestUrl();
  const baseResult: InstallGameStudioResult = { success: false, manifestUrl };
  try {
    const { manifest, base } = await parseGameManifest(manifestUrl, options.signal);
    const root = gameInstallRoot();
    const targetDir = path.join(root, 'versions', manifest.version);
    const current = readManagedCurrentPointer();
    if (current?.version === manifest.version && inspectCandidateDir(targetDir, 'managed')) {
      return {
        ...baseResult,
        success: true,
        installed: true,
        alreadyInstalled: true,
        version: manifest.version,
        ...(manifest.license ? { license: manifest.license } : {}),
        ...(manifest.archive.size ? { size: manifest.archive.size } : {}),
        path: targetDir
      };
    }

    const details = {
      ...baseResult,
      version: manifest.version,
      ...(manifest.license ? { license: manifest.license } : {}),
      ...(manifest.archive.size ? { size: manifest.archive.size } : {})
    };
    if (!options.confirm) {
      return { ...details, requiresConsent: true };
    }

    const bytes = await readArchiveBytes(manifest.archive.url, base, options.signal);
    if (manifest.archive.size !== undefined && bytes.length !== manifest.archive.size) {
      throw new Error('Causyne Game archive size does not match the manifest');
    }
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest.toLowerCase() !== manifest.archive.sha256.toLowerCase()) {
      throw new Error('Causyne Game archive SHA-256 does not match the manifest');
    }

    const versionsDir = path.join(root, 'versions');
    await fs.mkdir(versionsDir, { recursive: true, mode: 0o700 });
    const stageRoot = path.join(versionsDir, `.stage-${manifest.version}-${process.pid}-${Date.now()}`);
    const archivePath = path.join(stageRoot, 'bundle.tar.gz');
    const extractDir = path.join(stageRoot, 'extract');
    await fs.mkdir(extractDir, { recursive: true, mode: 0o700 });

    try {
      await fs.writeFile(archivePath, bytes, { mode: 0o600 });
      await verifyTarSafety(archivePath);
      await execFileAsync(resolveTarExecutable(), ['-xzf', path.basename(archivePath), '-C', path.basename(extractDir)], {
        cwd: stageRoot,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true
      });
      await assertNoEscapingSymlinks(extractDir);
      const validRoot = await resolveExtractedRoot(extractDir);
      await fs.rm(targetDir, { recursive: true, force: true });
      await fs.rename(validRoot, targetDir);
    } finally {
      await fs.rm(stageRoot, { recursive: true, force: true }).catch(() => {});
    }

    const pointerFile = path.join(root, 'current.json');
    const pointerTmp = `${pointerFile}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(pointerTmp, JSON.stringify({
      product: 'causyne-game',
      version: manifest.version,
      sha256: manifest.archive.sha256,
      installedAt: new Date().toISOString()
    }, null, 2), { mode: 0o600 });
    try {
      await fs.rename(pointerTmp, pointerFile);
    } catch (error) {
      await fs.rm(pointerTmp, { force: true }).catch(() => {});
      throw error;
    }

    return {
      ...details,
      success: true,
      installed: true,
      alreadyInstalled: false,
      path: targetDir
    };
  } catch (error) {
    return {
      ...baseResult,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
