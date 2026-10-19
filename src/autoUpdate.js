// Causyne package updates.
//
// Updates are intentionally limited to installations managed by npm or by the
// causyne.com installer. A source checkout is never rewritten. Commands are
// passed as argv arrays with shell disabled, and the only accepted package is
// the public @causyne/agent package from the npm registry.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { UI } from './utils/cli_ui.js';
import { causyneHome } from './utils/paths.js';
import { getPackageVersion } from './version.js';

const PACKAGE_NAME = '@causyne/agent';
const REGISTRY_LATEST = 'https://registry.npmjs.org/@causyne%2fagent/latest';
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function updateStateFile(options = {}) {
  if (options.stateFile) return path.resolve(options.stateFile);
  const env = options.env || process.env;
  const root = env.CAUSYNE_HOME && String(env.CAUSYNE_HOME).trim()
    ? path.resolve(String(env.CAUSYNE_HOME).trim())
    : causyneHome();
  return path.join(root, 'update-state.json');
}

function versionParts(version) {
  const match = String(version || '').trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return { numbers: match.slice(1, 4).map(Number), prerelease: match[4] || '' };
}

export function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  if (!a || !b) return 0;
  for (let index = 0; index < 3; index++) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] > b.numbers[index] ? 1 : -1;
  }
  if (a.prerelease === b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  const aParts = a.prerelease.split('.');
  const bParts = b.prerelease.split('.');
  const length = Math.max(aParts.length, bParts.length);
  for (let index = 0; index < length; index++) {
    if (aParts[index] === undefined) return -1;
    if (bParts[index] === undefined) return 1;
    if (aParts[index] === bParts[index]) continue;
    const aNumeric = /^\d+$/.test(aParts[index]);
    const bNumeric = /^\d+$/.test(bParts[index]);
    if (aNumeric && bNumeric) return Number(aParts[index]) > Number(bParts[index]) ? 1 : -1;
    if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
    return aParts[index].localeCompare(bParts[index]);
  }
  return 0;
}

function managedPrefix(packageRoot = PACKAGE_ROOT, env = process.env) {
  if (env.CAUSYNE_INSTALL_ROOT) return path.resolve(env.CAUSYNE_INSTALL_ROOT);

  const markers = [
    path.join('lib', 'node_modules', '@causyne', 'agent'),
    path.join('node_modules', '@causyne', 'agent')
  ];
  for (const marker of markers) {
    const index = packageRoot.lastIndexOf(marker);
    if (index >= 0 && index + marker.length === packageRoot.length) {
      return packageRoot.slice(0, index).replace(/[\\/]$/, '');
    }
  }
  return null;
}

export function installationInfo(options = {}) {
  const env = options.env || process.env;
  const packageRoot = options.packageRoot || PACKAGE_ROOT;
  const prefix = managedPrefix(packageRoot, env);
  return {
    managed: Boolean(prefix),
    type: env.CAUSYNE_INSTALL_ROOT ? 'causyne.com installer' : (prefix ? 'global npm' : 'source checkout'),
    prefix,
    packageRoot,
    npmCommand: env.CAUSYNE_NPM_COMMAND || (process.platform === 'win32' ? 'npm.cmd' : 'npm')
  };
}

function readState(options = {}) {
  try {
    return JSON.parse(fs.readFileSync(updateStateFile(options), 'utf8'));
  } catch {
    return {};
  }
}

function writeState(state, options = {}) {
  try {
    const stateFile = updateStateFile(options);
    fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
  } catch {
    // Update state is an optimisation. Failure must never stop the CLI.
  }
}

export async function latestPackageVersion(options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('This Node.js runtime has no fetch implementation.');
  const timeoutMs = options.timeoutMs || 3500;
  const signal = options.signal || AbortSignal.timeout(timeoutMs);
  const response = await fetchImpl(REGISTRY_LATEST, {
    headers: { accept: 'application/json', 'user-agent': `causyne/${getPackageVersion()}` },
    signal
  });
  if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`);
  const metadata = await response.json();
  if (metadata.name !== PACKAGE_NAME || !versionParts(metadata.version)) {
    throw new Error('npm registry returned invalid package metadata');
  }
  return metadata.version;
}

function installLatest(info, options = {}) {
  const runner = options.spawnSyncImpl || spawnSync;
  const args = [
    'install', '--global', '--prefix', info.prefix,
    `${PACKAGE_NAME}@${options.version}`, '--ignore-scripts', '--no-audit', '--no-fund'
  ];
  const result = runner(info.npmCommand, args, {
    shell: false,
    stdio: options.verbose ? 'inherit' : 'pipe',
    encoding: 'utf8',
    env: options.env || process.env
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim();
    throw new Error(detail || `npm exited with status ${result.status}`);
  }
}

export async function checkForUpdate(options = {}) {
  const current = options.currentVersion || getPackageVersion();
  const latest = await latestPackageVersion(options);
  return { current, latest, available: compareVersions(latest, current) > 0 };
}

export async function runSelfUpdate(verbose = false, options = {}) {
  const info = installationInfo(options);
  if (!info.managed) {
    if (verbose) UI.printInfo('This is a source checkout. Update it with Git; Causyne will not rewrite developer source.');
    return { updated: false, reason: 'source-checkout', ...info };
  }

  try {
    const status = await checkForUpdate(options);
    if (!status.available) {
      writeState({ checkedAt: Date.now(), latest: status.latest }, options);
      if (verbose) UI.printSuccess(`Causyne ${status.current} is up to date.`);
      return { updated: false, reason: 'current', ...status, ...info };
    }

    if (verbose) UI.printInfo(`Updating Causyne ${status.current} → ${status.latest}...`);
    installLatest(info, { ...options, version: status.latest, verbose });
    writeState({ checkedAt: Date.now(), latest: status.latest, installedAt: Date.now() }, options);
    if (verbose) UI.printSuccess(`Updated to Causyne ${status.latest}.`);
    return { updated: true, ...status, ...info };
  } catch (error) {
    writeState({ checkedAt: Date.now(), error: error.message }, options);
    if (verbose) UI.printError(`Update failed: ${error.message}`);
    return { updated: false, reason: 'failed', error: error.message, ...info };
  }
}

/** Check on launch, at most once every six hours. */
export async function startUpdateChecker(options = {}) {
  const env = options.env || process.env;
  if (env.CAUSYNE_DISABLE_AUTOUPDATE === '1' || env.CAUSYNE_DISABLE_AUTOUPDATE === 'true') {
    return { updated: false, reason: 'disabled' };
  }

  const info = installationInfo(options);
  if (!info.managed) return { updated: false, reason: 'source-checkout', ...info };

  const state = readState(options);
  if (!options.force && Number.isFinite(state.checkedAt)
      && Date.now() - state.checkedAt < CHECK_INTERVAL_MS) {
    return { updated: false, reason: 'recently-checked', latest: state.latest, ...info };
  }

  return runSelfUpdate(false, options);
}

export async function diagnoseInstallation(options = {}) {
  const info = installationInfo(options);
  let update;
  try {
    update = await checkForUpdate(options);
  } catch (error) {
    update = { current: getPackageVersion(), latest: null, available: false, error: error.message };
  }
  return {
    ...info,
    ...update,
    autoUpdates: !['1', 'true'].includes(String((options.env || process.env).CAUSYNE_DISABLE_AUTOUPDATE || '').toLowerCase())
  };
}

export function formatDoctorReport(status, runtime = process) {
  const rows = [
    `Version       : ${status.current}`,
    `Latest        : ${status.latest || `unavailable (${status.error || 'unknown error'})`}`,
    `Installation  : ${status.type}`,
    `Package root  : ${status.packageRoot}`,
    `Node.js       : ${runtime.version}`,
    `Platform      : ${runtime.platform} ${runtime.arch}`,
    `Auto updates  : ${status.autoUpdates ? 'enabled' : 'disabled'}`,
    `Workspace     : ${runtime.cwd()}`
  ];
  if (status.available) rows.push('Update         : available — run `causyne update`');
  return rows.join('\n');
}
