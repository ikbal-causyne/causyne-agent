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
const DEFAULT_CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour for active developer agility
const ERROR_RETRY_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes retry on network error
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function updateStateFile(options = {}) {
    if (options.stateFile)
        return path.resolve(options.stateFile);
    const env = options.env || process.env;
    const root = env.CAUSYNE_HOME && String(env.CAUSYNE_HOME).trim()
        ? path.resolve(String(env.CAUSYNE_HOME).trim())
        : causyneHome();
    return path.join(root, 'update-state.json');
}
export function versionParts(version) {
    const match = String(version || '').trim().match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
    if (!match)
        return null;
    const num1 = Number(match[1]);
    const num2 = Number(match[2]);
    const num3 = Number(match[3]);
    return { numbers: [num1, num2, num3], prerelease: match[4] || '' };
}
export function compareVersions(left, right) {
    const a = versionParts(left);
    const b = versionParts(right);
    if (!a || !b)
        return 0;
    for (let index = 0; index < 3; index++) {
        const aNum = a.numbers[index] ?? 0;
        const bNum = b.numbers[index] ?? 0;
        if (aNum !== bNum)
            return aNum > bNum ? 1 : -1;
    }
    if (a.prerelease === b.prerelease)
        return 0;
    if (!a.prerelease)
        return 1;
    if (!b.prerelease)
        return -1;
    const aParts = a.prerelease.split('.');
    const bParts = b.prerelease.split('.');
    const length = Math.max(aParts.length, bParts.length);
    for (let index = 0; index < length; index++) {
        const aPart = aParts[index];
        const bPart = bParts[index];
        if (aPart === undefined)
            return -1;
        if (bPart === undefined)
            return 1;
        if (aPart === bPart)
            continue;
        const aNumeric = /^\d+$/.test(aPart);
        const bNumeric = /^\d+$/.test(bPart);
        if (aNumeric && bNumeric)
            return Number(aPart) > Number(bPart) ? 1 : -1;
        if (aNumeric !== bNumeric)
            return aNumeric ? -1 : 1;
        return aPart.localeCompare(bPart);
    }
    return 0;
}
function managedPrefix(packageRoot = PACKAGE_ROOT, env = process.env) {
    if (env.CAUSYNE_INSTALL_ROOT)
        return path.resolve(env.CAUSYNE_INSTALL_ROOT);
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
export function resolveNpmExecutable(env = process.env) {
    if (env.CAUSYNE_NPM_COMMAND && String(env.CAUSYNE_NPM_COMMAND).trim()) {
        return String(env.CAUSYNE_NPM_COMMAND).trim();
    }
    const isWin = process.platform === 'win32';
    const npmName = isWin ? 'npm.cmd' : 'npm';
    // 1. Sibling of running node binary (most reliable across all Node version managers: nvm, fnm, volta, mise)
    if (process.execPath) {
        const sibling = path.join(path.dirname(process.execPath), npmName);
        if (fs.existsSync(sibling)) {
            return sibling;
        }
    }
    // 2. Private Causyne runtime if provisioned
    const privateNpm = path.join(causyneHome(), 'runtime', 'node', isWin ? '' : 'bin', npmName);
    if (fs.existsSync(privateNpm)) {
        return privateNpm;
    }
    // 3. Default fallback to system PATH
    return npmName;
}
export function installationInfo(options = {}) {
    const env = options.env || process.env;
    const packageRoot = options.packageRoot || PACKAGE_ROOT;
    const prefix = managedPrefix(packageRoot, env);
    const npmCommand = resolveNpmExecutable(env);
    return {
        managed: Boolean(prefix),
        type: env.CAUSYNE_INSTALL_ROOT ? 'causyne.com installer' : (prefix ? 'global npm' : 'source checkout'),
        prefix,
        packageRoot,
        npmCommand
    };
}
function readState(options = {}) {
    try {
        return JSON.parse(fs.readFileSync(updateStateFile(options), 'utf8'));
    }
    catch {
        return {};
    }
}
function writeState(state, options = {}) {
    try {
        const stateFile = updateStateFile(options);
        fs.mkdirSync(path.dirname(stateFile), { recursive: true, mode: 0o700 });
        fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
    }
    catch {
        // Update state is an optimisation. Failure must never stop the CLI.
    }
}
export async function latestPackageVersion(options = {}) {
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    if (typeof fetchImpl !== 'function')
        throw new Error('This Node.js runtime has no fetch implementation.');
    const timeoutMs = options.timeoutMs || 3500;
    const signal = options.signal || AbortSignal.timeout(timeoutMs);
    const response = await fetchImpl(REGISTRY_LATEST, {
        headers: { accept: 'application/json', 'user-agent': `causyne/${getPackageVersion()}` },
        signal
    });
    if (!response.ok)
        throw new Error(`npm registry returned HTTP ${response.status}`);
    const metadata = (await response.json());
    if (metadata.name !== PACKAGE_NAME || !versionParts(metadata.version)) {
        throw new Error('npm registry returned invalid package metadata');
    }
    return metadata.version;
}
function installLatest(info, options = {}) {
    if (!info.prefix) {
        throw new Error('Cannot install package: prefix is not defined for this installation.');
    }
    const runner = options.spawnSyncImpl || spawnSync;
    const targetVersion = options.version;
    if (!targetVersion) {
        throw new Error('Target version must be specified for installation.');
    }
    const args = [
        'install', '--global', '--prefix', info.prefix,
        `${PACKAGE_NAME}@${targetVersion}`, '--ignore-scripts', '--no-audit', '--no-fund'
    ];
    // Prepend the directory containing node and npm to PATH so child npm executes smoothly
    const env = { ...(options.env || process.env) };
    const extraPaths = [path.dirname(process.execPath)];
    if (info.npmCommand.includes('/') || info.npmCommand.includes('\\')) {
        extraPaths.push(path.dirname(info.npmCommand));
    }
    const delimiter = process.platform === 'win32' ? ';' : ':';
    const currentPath = env.PATH || env.Path || '';
    env.PATH = [...extraPaths, currentPath].filter(Boolean).join(delimiter);
    const result = runner(info.npmCommand, args, {
        shell: false,
        stdio: options.verbose ? 'inherit' : 'pipe',
        encoding: 'utf8',
        env
    });
    if (result.error)
        throw result.error;
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
        if (verbose)
            UI.printInfo('This is a source checkout. Update it with Git; Causyne will not rewrite developer source.');
        return { updated: false, reason: 'source-checkout', ...info };
    }
    try {
        const status = await checkForUpdate(options);
        if (!status.available) {
            writeState({ checkedAt: Date.now(), latest: status.latest }, options);
            if (verbose)
                UI.printSuccess(`Causyne ${status.current} is up to date.`);
            return { updated: false, reason: 'current', ...status, ...info };
        }
        if (verbose)
            UI.printInfo(`Updating Causyne ${status.current} → ${status.latest}...`);
        installLatest(info, { ...options, version: status.latest, verbose });
        writeState({ checkedAt: Date.now(), latest: status.latest, installedAt: Date.now() }, options);
        if (verbose)
            UI.printSuccess(`Updated to Causyne ${status.latest}.`);
        return { updated: true, ...status, ...info };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        writeState({ checkedAt: Date.now(), error: message }, options);
        if (verbose)
            UI.printError(`Update failed: ${message}`);
        return { updated: false, reason: 'failed', error: message, ...info };
    }
}
/** Check on launch, defaulting to at most once per hour with fast retry on error. */
export async function startUpdateChecker(options = {}) {
    const env = options.env || process.env;
    if (env.CAUSYNE_DISABLE_AUTOUPDATE === '1' || env.CAUSYNE_DISABLE_AUTOUPDATE === 'true') {
        return {
            updated: false,
            reason: 'disabled',
            managed: false,
            type: 'source checkout',
            prefix: null,
            packageRoot: PACKAGE_ROOT,
            npmCommand: resolveNpmExecutable(env)
        };
    }
    const info = installationInfo(options);
    if (!info.managed)
        return { updated: false, reason: 'source-checkout', ...info };
    const customInterval = Number(env.CAUSYNE_UPDATE_INTERVAL_MS);
    const checkInterval = Number.isFinite(customInterval) && customInterval > 0
        ? customInterval
        : DEFAULT_CHECK_INTERVAL_MS;
    const state = readState(options);
    if (!options.force && Number.isFinite(state.checkedAt)) {
        const elapsed = Date.now() - state.checkedAt;
        const intervalToUse = state.error ? ERROR_RETRY_INTERVAL_MS : checkInterval;
        if (elapsed < intervalToUse) {
            return { updated: false, reason: 'recently-checked', latest: state.latest, ...info };
        }
    }
    return runSelfUpdate(false, options);
}
export async function diagnoseInstallation(options = {}) {
    const info = installationInfo(options);
    let update;
    try {
        update = await checkForUpdate(options);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        update = { current: getPackageVersion(), latest: null, available: false, error: message };
    }
    return {
        ...info,
        ...update,
        autoUpdates: !['1', 'true'].includes(String((options.env || process.env).CAUSYNE_DISABLE_AUTOUPDATE || '').toLowerCase())
    };
}
export function formatDoctorReport(status, runtime = process) {
    const rows = [
        `Version       : ${status.current || 'unknown'}`,
        `Latest        : ${status.latest || `unavailable (${status.error || 'unknown error'})`}`,
        `Installation  : ${status.type}`,
        `Package root  : ${status.packageRoot}`,
        `NPM command   : ${status.npmCommand}`,
        `Node.js       : ${runtime.version}`,
        `Platform      : ${runtime.platform} ${runtime.arch}`,
        `Auto updates  : ${status.autoUpdates ? 'enabled' : 'disabled'}`,
        `Workspace     : ${runtime.cwd()}`
    ];
    if (status.available)
        rows.push('Update         : available — run `causyne update`');
    return rows.join('\n');
}
