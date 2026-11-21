import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { installCapabilityManifest } from './npmInstall.js';
import { loadConfig, saveConfig } from '../config.js';
import { isGroupGranted, isGroupDeclined } from './capabilityConsent.js';
import { causyneHome } from '../utils/paths.js';
import { currentToolAutonomyMode } from '../approvalPolicy.js';
import { isWithinPhysicalPath, physicalPath } from '../agent/workspaceBoundary.js';
import { redactProviderSecrets } from '../providers/byokHttp.js';
import { safeDisplay } from '../tui/text.js';

export interface CapabilityVerdict {
  ok: boolean;
  group: string;
  reason?: string;
  requiresConsent?: boolean;
}

export interface GroupStatusResult {
  state: 'unknown' | 'ready' | 'granted-not-installed' | 'needs-consent';
  group: string;
  description?: string;
}

export interface ProvisionResult {
  installed: string[];
  skipped: boolean;
}

const NPM_PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]{0,63}\/)?[a-z0-9][a-z0-9._-]{0,127}$/i;

export function isValidNpmPackageName(packageName: unknown): packageName is string {
  if (typeof packageName !== 'string' || packageName.length === 0 || packageName.length > 214) return false;
  if (packageName.includes('\0') || packageName.includes('..') || packageName.includes('\\')) return false;
  if (packageName.startsWith('.') || packageName.startsWith('/') || packageName.includes(':')) return false;
  return NPM_PACKAGE_NAME_RE.test(packageName);
}

function capabilityDir(): string {
  return path.join(causyneHome(), 'capabilities');
}

// Groups exist so consent is asked once per capability a human recognises
// ("let it see the screen"), not once per npm package. Names stay in value
// position — see the D-5 note above.
const GROUP_PACKAGES: Record<string, ReadonlyArray<readonly [string, string]>> = {
  browser: [
    ['camoufox-js', '0.11.5'],
    ['playwright-core', '1.58.0']
  ],
  vision: [
    ['puppeteer-core', '25.8.0'],
    ['screenshot-desktop', '1.15.6']
  ],
  ocr: [
    ['tesseract.js', '7.0.0']
  ],
  system: [
    ['systeminformation', '5.33.1']
  ],
  desktop: [
    ['clipboardy', '5.3.2'],
    ['open', '11.0.1'],
    ['trash', '10.1.1']
  ],
  archive: [
    ['archiver', '8.0.0'],
    ['extract-zip', '2.0.1']
  ]
};

// What the user is actually agreeing to. This text reaches the approval prompt
// rather than listing package names.
export const GROUP_DESCRIPTIONS: Record<string, string> = {
  browser: 'use the Causyne Browser runtime for rendered navigation, extraction, and workspace-scoped downloads; Causyne never downloads the browser binary automatically',
  vision: 'drive a browser and capture the screen, so the agent can look at what it built',
  ocr: 'read text out of images and screenshots',
  system: 'list running processes and read system load',
  desktop: 'use the clipboard, open files in their default application, and delete to the recycle bin',
  archive: 'create and extract zip archives'
};

export const GROUP_NAMES: string[] = Object.keys(GROUP_PACKAGES);

export function isKnownGroup(group: unknown): group is string {
  return typeof group === 'string' && Object.hasOwn(GROUP_PACKAGES, group);
}

/** Which group owns a package, or null when the package is not ours. */
export function groupForPackage(packageName: string): string | null {
  if (!isValidNpmPackageName(packageName)) return null;
  for (const [group, packages] of Object.entries(GROUP_PACKAGES)) {
    if (packages.some(([name]) => name === packageName)) return group;
  }
  return null;
}

function manifestFor(groups: readonly string[]): Record<string, unknown> {
  const dependencies: Array<readonly [string, string]> = [];
  for (const group of groups) {
    if (!isKnownGroup(group)) continue;
    for (const entry of GROUP_PACKAGES[group] || []) dependencies.push(entry);
  }
  return {
    name: 'causyne-capabilities-env',
    version: '1.0.0',
    private: true,
    // Keys are produced at runtime; the names above never sit in key position.
    dependencies: Object.fromEntries(dependencies)
  };
}

// ---------------------------------------------------------------------------
// Consent
// ---------------------------------------------------------------------------

export function grantedGroups(): string[] {
  return GROUP_NAMES.filter(isGroupGranted);
}

export function grantGroup(group: string): boolean {
  if (!isKnownGroup(group)) return false;
  const config = loadConfig();
  config.capabilityConsent = { ...(config.capabilityConsent || {}), [group]: true };
  saveConfig(config);
  return true;
}

export { isGroupGranted, isGroupDeclined };

export function revokeGroup(group: string): boolean {
  if (!isKnownGroup(group)) return false;
  const config = loadConfig();
  config.capabilityConsent = { ...(config.capabilityConsent || {}), [group]: false };
  saveConfig(config);
  return true;
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

/** True when the package is already on disk in the sovereign directory. */
export function isPackageInstalled(packageName: string): boolean {
  if (!isValidNpmPackageName(packageName)) return false;
  const nodeModulesDir = path.join(capabilityDir(), 'node_modules');
  const target = path.join(nodeModulesDir, packageName);
  try {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) return false;
    const realRoot = physicalPath(nodeModulesDir);
    const realTarget = physicalPath(target);
    if (!realRoot || !realTarget || realTarget === realRoot) return false;
    return isWithinPhysicalPath(realTarget, realRoot);
  } catch {
    return false;
  }
}

export function isGroupInstalled(group: string): boolean {
  if (!isKnownGroup(group)) return false;
  const packages = GROUP_PACKAGES[group] || [];
  return packages.length > 0 && packages.every(([name]) => isPackageInstalled(name));
}

/**
 * Whether a group can be used right now, and if not, why.
 *
 * Deliberately three states, not two. "Not granted" is a question for the user;
 * "granted but not installed" is work the agent can do; "unavailable" is a
 * dead end the model should route around rather than retry.
 */
export function groupStatus(group: string): GroupStatusResult {
  if (!isKnownGroup(group)) return { state: 'unknown', group: typeof group === 'string' ? group : '' };
  if (isGroupInstalled(group)) return { state: 'ready', group };
  if (isGroupGranted(group)) return { state: 'granted-not-installed', group };
  const description = Object.hasOwn(GROUP_DESCRIPTIONS, group) ? GROUP_DESCRIPTIONS[group] : undefined;
  return description !== undefined ? { state: 'needs-consent', group, description } : { state: 'needs-consent', group };
}

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

/**
 * Install every granted group into ~/.causyne/capabilities.
 *
 * Runs `npm i` from a written manifest with no explicit package arguments, so a
 * lockfile is produced and the resulting tree can be audited with `npm audit` —
 * the same correction finding D-4 forced on the cortex provisioner, where
 * `--no-save` had left a tree that could not be checked at all.
 */
export async function provisionCapabilities(groups?: string[] | null): Promise<ProvisionResult> {
  const requested = Array.isArray(groups) ? groups : [];
  const target = [...new Set([...grantedGroups(), ...requested])].filter(isKnownGroup);
  if (target.length === 0) return { installed: [], skipped: true };

  const dir = capabilityDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  } else {
    const dirStat = fs.lstatSync(dir);
    if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
      throw new Error('Refusing symlink or non-directory capability root');
    }
  }
  if (process.platform !== 'win32') {
    try { fs.chmodSync(dir, 0o700); } catch { /* ignore */ }
  }

  const manifestPath = path.join(dir, 'package.json');
  const desired = JSON.stringify(manifestFor(target), null, 2);

  let needsInstall = true;
  try {
    const mStat = fs.lstatSync(manifestPath);
    if (mStat.isSymbolicLink() || !mStat.isFile()) {
      throw new Error('Refusing symlink or non-regular capability package.json');
    }
    needsInstall = fs.readFileSync(manifestPath, 'utf8') !== desired;
  } catch (err: unknown) {
    const code = typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : '';
    if (code !== 'ENOENT') throw err;
  }
  if (needsInstall) {
    const tempPath = `${manifestPath}.tmp_${process.pid}_${crypto.randomBytes(6).toString('hex')}`;
    const payload = Buffer.from(desired, 'utf8');
    try {
      const fd = fs.openSync(tempPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      try {
        fs.writeSync(fd, payload, 0, payload.length);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tempPath, manifestPath);
    } catch (writeErr: unknown) {
      try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch { /* ignore */ }
      throw writeErr;
    }
  }

  const lockPath = path.join(dir, 'package-lock.json');
  try {
    const lockStat = fs.lstatSync(lockPath);
    if (lockStat.isSymbolicLink() || !lockStat.isFile()) needsInstall = true;
  } catch {
    needsInstall = true;
  }
  for (const group of target) {
    if (!isGroupInstalled(group)) { needsInstall = true; break; }
  }

  if (!needsInstall) return { installed: target, skipped: true };

  installCapabilityManifest(dir);
  return { installed: target, skipped: false };
}

/**
 * The call every capability-backed tool makes first.
 *
 * Returns a plain verdict rather than throwing, because the caller has to turn
 * it into an honest tool result: the model must learn that the capability is
 * unavailable, not that something crashed.
 */
export async function ensureCapability(group: string): Promise<CapabilityVerdict> {
  if (isGroupDeclined(group)) {
    return { ok: false, group, reason: `The "${group}" capability was explicitly disabled by the user.` };
  }
  const status = groupStatus(group);
  if (status.state === 'ready') return { ok: true, group };
  if (status.state === 'unknown') return { ok: false, group, reason: `Unknown capability group "${group}".` };

  if (status.state === 'needs-consent') {
    // Mode C authorizes installation needed by the in-scope tool call. This
    // does not persist a standing capability grant across sessions. A group
    // explicitly revoked by the user stays disabled.
    if (currentToolAutonomyMode() === 'C' && !isGroupDeclined(group)) {
      try {
        await provisionCapabilities([group]);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        return { ok: false, group, reason: `The "${group}" capability could not be prepared: ${msg}` };
      }
      return isGroupInstalled(group)
        ? { ok: true, group }
        : { ok: false, group, reason: `The "${group}" capability is unavailable in this environment.` };
    }
    return {
      ok: false,
      group,
      requiresConsent: true,
      reason: `This tool needs the "${group}" capability — permission to ${GROUP_DESCRIPTIONS[group]}. ` +
              `It has not been granted yet, so the tool cannot run. To enable it, call ` +
              `manage_local_dependencies with action "grant_capability" and group "${group}"; ` +
              `that request goes to the user for approval.`
    };
  }

  // Granted but not yet on disk — do the work now.
  try {
    await provisionCapabilities([group]);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, group, reason: `The "${group}" capability could not be prepared: ${msg}` };
  }
  return isGroupInstalled(group)
    ? { ok: true, group }
    : { ok: false, group, reason: `The "${group}" capability is unavailable in this environment.` };
}

/**
 * Load a provisioned module.
 *
 * Mirrors requireCortexModule: resolve through Node's own resolver against the
 * sovereign directory so `main`/`exports` are honoured, then import a real file
 * URL. Passing a package DIRECTORY to import() throws ERR_UNSUPPORTED_DIR_IMPORT,
 * which is the bug that silently disabled the entire V5 Cortex once already.
 */
export async function requireCapabilityModule(packageName: string): Promise<any> {
  const dir = capabilityDir();
  const modulePath = path.join(dir, 'node_modules', packageName);
  if (!fs.existsSync(modulePath)) {
    throw new Error(`Capability module ${packageName} is not provisioned.`);
  }

  const capabilityRequire = createRequire(path.join(dir, 'package.json'));
  let entryPoint: string;
  try {
    entryPoint = capabilityRequire.resolve(packageName);
  } catch (resolveError: unknown) {
    const manifestPath = path.join(modulePath, 'package.json');
    let mainField = 'index.js';
    if (fs.existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
        mainField = String(manifest.main || manifest.module || 'index.js');
      } catch { /* ignore */ }
    }
    entryPoint = path.join(modulePath, mainField);
    if (!fs.existsSync(entryPoint)) {
      const msg = resolveError instanceof Error ? resolveError.message : String(resolveError);
      throw new Error(`Capability module ${packageName} has no resolvable entry point: ${msg}`);
    }
  }

  const mod: any = await import(pathToFileURL(entryPoint).href);
  return mod.default || mod;
}

/**
 * Load a package, preferring one that is already reachable from the agent's own
 * install (a developer running from source may simply have it) and falling back
 * to the sovereign directory. Tools call this instead of a bare dynamic import.
 */
export async function loadCapabilityPackage(packageName: string): Promise<any> {
  try {
    const local: any = await import(packageName);
    return local.default || local;
  } catch {
    try {
      return await requireCapabilityModule(packageName);
    } catch {
      // Some packages already exist in the Cortex tree as pinned overrides
      // (sharp, for one). Reuse them rather than installing a second copy that
      // could drift to a different version than the one that was audited.
      const { requireCortexModule } = await import('../cortex/provisioner.js');
      return requireCortexModule(packageName);
    }
  }
}

export function capabilityDirectory(): string {
  return capabilityDir();
}
