

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'url';
import { loadConfig, saveConfig } from '../config.js';
import { isGroupGranted, isGroupDeclined } from './capabilityConsent.js';
import { causyneHome } from '../utils/paths.js';

const CAPABILITY_DIR = path.join(causyneHome(), 'capabilities');

// Groups exist so consent is asked once per capability a human recognises
// ("let it see the screen"), not once per npm package. Names stay in value
// position — see the D-5 note above.
const GROUP_PACKAGES = {
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

// than listing package names.
export const GROUP_DESCRIPTIONS = {
  vision: 'drive a browser and capture the screen, so the agent can look at what it built',
  ocr: 'read text out of images and screenshots',
  system: 'list running processes and read system load',
  desktop: 'use the clipboard, open files in their default application, and delete to the recycle bin',
  archive: 'create and extract zip archives'
};

export const GROUP_NAMES = Object.keys(GROUP_PACKAGES);

/** Which group owns a package, or null when the package is not ours. */
export function groupForPackage(packageName) {
  for (const [group, packages] of Object.entries(GROUP_PACKAGES)) {
    if (packages.some(([name]) => name === packageName)) return group;
  }
  return null;
}

function manifestFor(groups) {
  const dependencies = [];
  for (const group of groups) {
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


export function grantedGroups() {
  return GROUP_NAMES.filter(isGroupGranted);
}

export function grantGroup(group) {
  if (!GROUP_PACKAGES[group]) return false;
  const config = loadConfig();
  config.capabilityConsent = { ...(config.capabilityConsent || {}), [group]: true };
  saveConfig(config);
  return true;
}

export { isGroupGranted, isGroupDeclined };

export function revokeGroup(group) {
  const config = loadConfig();
  config.capabilityConsent = { ...(config.capabilityConsent || {}), [group]: false };
  saveConfig(config);
  return true;
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

/** True when the package is already on disk in the sovereign directory. */
export function isPackageInstalled(packageName) {
  return fs.existsSync(path.join(CAPABILITY_DIR, 'node_modules', packageName));
}

export function isGroupInstalled(group) {
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
export function groupStatus(group) {
  if (!GROUP_PACKAGES[group]) return { state: 'unknown', group };
  if (isGroupInstalled(group)) return { state: 'ready', group };
  if (isGroupGranted(group)) return { state: 'granted-not-installed', group };
  return { state: 'needs-consent', group, description: GROUP_DESCRIPTIONS[group] };
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
 *
 * @param {string[]} groups groups to ensure are present, added to those already granted
 */
export async function provisionCapabilities(groups = []) {
  const target = [...new Set([...grantedGroups(), ...groups])].filter(g => GROUP_PACKAGES[g]);
  if (target.length === 0) return { installed: [], skipped: true };

  if (!fs.existsSync(CAPABILITY_DIR)) {
    fs.mkdirSync(CAPABILITY_DIR, { recursive: true, mode: 0o700 });
  }

  const manifestPath = path.join(CAPABILITY_DIR, 'package.json');
  const desired = JSON.stringify(manifestFor(target), null, 2);

  let needsInstall = true;
  if (fs.existsSync(manifestPath)) {
    try { needsInstall = fs.readFileSync(manifestPath, 'utf8') !== desired; } catch (e) {}
  }
  if (needsInstall) fs.writeFileSync(manifestPath, desired);

  if (!fs.existsSync(path.join(CAPABILITY_DIR, 'package-lock.json'))) needsInstall = true;
  for (const group of target) {
    if (!isGroupInstalled(group)) { needsInstall = true; break; }
  }

  if (!needsInstall) return { installed: target, skipped: true };

  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  execFileSync(
    npm,
    ['install', '--ignore-scripts', '--no-fund'],
    { cwd: CAPABILITY_DIR, stdio: 'inherit' }
  );
  return { installed: target, skipped: false };
}

/**
 * The call every capability-backed tool makes first.
 *
 * Returns a plain verdict rather than throwing, because the caller has to turn
 * it into an honest tool result: the model must learn that the capability is
 * unavailable, not that something crashed.
 */
export async function ensureCapability(group) {
  const status = groupStatus(group);
  if (status.state === 'ready') return { ok: true, group };
  if (status.state === 'unknown') return { ok: false, group, reason: `Unknown capability group "${group}".` };

  if (status.state === 'needs-consent') {
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
  } catch (e) {
    return { ok: false, group, reason: `The "${group}" capability could not be prepared: ${e.message}` };
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
export async function requireCapabilityModule(packageName) {
  const modulePath = path.join(CAPABILITY_DIR, 'node_modules', packageName);
  if (!fs.existsSync(modulePath)) {
    throw new Error(`Capability module ${packageName} is not provisioned.`);
  }

  const capabilityRequire = createRequire(path.join(CAPABILITY_DIR, 'package.json'));
  let entryPoint;
  try {
    entryPoint = capabilityRequire.resolve(packageName);
  } catch (resolveError) {
    const manifestPath = path.join(modulePath, 'package.json');
    let mainField = 'index.js';
    if (fs.existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        mainField = manifest.main || manifest.module || 'index.js';
      } catch (e) {}
    }
    entryPoint = path.join(modulePath, mainField);
    if (!fs.existsSync(entryPoint)) {
      throw new Error(`Capability module ${packageName} has no resolvable entry point: ${resolveError.message}`);
    }
  }

  const mod = await import(pathToFileURL(entryPoint).href);
  return mod.default || mod;
}

/**
 * Load a package, preferring one that is already reachable from the agent's own
 * install (a developer running from source may simply have it) and falling back
 * to the sovereign directory. Tools call this instead of a bare dynamic import.
 */
export async function loadCapabilityPackage(packageName) {
  try {
    const local = await import(packageName);
    return local.default || local;
  } catch (e) {
    try {
      return await requireCapabilityModule(packageName);
    } catch (capabilityError) {
      // Some packages already exist in the Cortex tree as pinned overrides
      // (sharp, for one). Reuse them rather than installing a second copy that
      // could drift to a different version than the one that was audited.
      const { requireCortexModule } = await import('../cortex/provisioner.js');
      return requireCortexModule(packageName);
    }
  }
}

export function capabilityDirectory() {
  return CAPABILITY_DIR;
}
