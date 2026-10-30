import crypto from 'node:crypto';
import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Adapted from Jo Inc's MIT-licensed Camofox Browser external executable
// discovery at commit 2c0036a8b18bf9cd983376751ff4d52dfd9add0f. Causyne
// keeps this integration layer in TypeScript and never downloads a browser.

export interface PreparedBrowserRuntime {
  installDirectory: string;
  resourceDirectory: string;
  executablePath?: string;
  source: 'environment' | 'system';
  engine?: 'chromium';
}

function resolveCandidateExecutablePath(candidate: string): string {
  if (!existsSync(candidate)) return candidate;
  try {
    const stat = statSync(candidate);
    if (stat.isDirectory()) {
      const nestedCandidates = [
        path.join(candidate, 'Contents', 'MacOS', 'camoufox'),
        path.join(candidate, 'Camoufox.app', 'Contents', 'MacOS', 'camoufox'),
        path.join(candidate, 'camoufox-bin'),
        path.join(candidate, 'camoufox'),
        path.join(candidate, 'camoufox.exe')
      ];
      const found = nestedCandidates.find(existsSync);
      if (found) return found;
    }
  } catch {
    // Fall through to assertExecutable for deterministic error reporting.
  }
  return candidate;
}

function assertExecutable(candidate: string): void {
  const stat = statSync(candidate);
  if (!stat.isFile() && !stat.isSymbolicLink()) {
    throw new Error(`Causyne Browser executable is not a file: ${candidate}`);
  }
  if (process.platform !== 'win32') accessSync(candidate, constants.X_OK);
}

function candidateExecutables(): string[] {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return [
      path.join(home, 'Library', 'Caches', 'camoufox', 'Camoufox.app', 'Contents', 'MacOS', 'camoufox'),
      path.join(home, 'Library', 'Application Support', 'camoufox', 'Camoufox.app', 'Contents', 'MacOS', 'camoufox'),
      path.join(home, '.cache', 'camoufox', 'Camoufox.app', 'Contents', 'MacOS', 'camoufox'),
      '/Applications/Camoufox.app/Contents/MacOS/camoufox',
      path.join(home, 'Applications', 'Camoufox.app', 'Contents', 'MacOS', 'camoufox'),
      '/opt/homebrew/bin/camoufox',
      '/usr/local/bin/camoufox'
    ];
  }
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    const programFiles = process.env.ProgramFiles;
    return [
      ...(localAppData ? [path.join(localAppData, 'camoufox', 'camoufox.exe')] : []),
      ...(localAppData ? [path.join(localAppData, 'Camoufox', 'camoufox.exe')] : []),
      ...(programFiles ? [path.join(programFiles, 'Camoufox', 'camoufox.exe')] : []),
      path.join(home, '.cache', 'camoufox', 'camoufox.exe')
    ];
  }
  return [
    path.join(home, '.cache', 'camoufox', 'camoufox-bin'),
    '/opt/camoufox/camoufox-bin',
    '/opt/camoufox/camoufox',
    path.join(home, '.local', 'share', 'camoufox', 'camoufox-bin'),
    path.join(home, '.local', 'bin', 'camoufox'),
    '/usr/local/lib/camoufox/camoufox-bin',
    '/usr/local/bin/camoufox',
    '/usr/bin/camoufox'
  ];
}

function expectedExecutable(installDirectory: string): string {
  if (process.platform === 'darwin') {
    return path.join(installDirectory, 'Camoufox.app', 'Contents', 'MacOS', 'camoufox');
  }
  if (process.platform === 'win32') return path.join(installDirectory, 'camoufox.exe');
  return path.join(installDirectory, 'camoufox-bin');
}

function nixStoreRoot(candidatePath: string): string | null {
  const match = candidatePath.match(/^\/nix\/store\/[^/]+/);
  return match?.[0] ?? null;
}

function collectDirs(root: string, maxDepth = 4): string[] {
  const dirs: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    const { dir, depth } = current;
    if (seen.has(dir)) continue;
    seen.add(dir);
    dirs.push(dir);
    if (depth >= maxDepth) continue;

    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      queue.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
    }
  }

  return dirs;
}

function findInstallDirectory(executablePath: string): string | null {
  let current = path.dirname(executablePath);
  for (let depth = 0; depth < 7; depth += 1) {
    if (existsSync(path.join(current, 'version.json')) && existsSync(expectedExecutable(current))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function findResourceDirectory(executablePath: string, resolvedExecutable: string): string | null {
  const directCandidates: string[] = [];
  if (process.platform === 'darwin') {
    directCandidates.push(path.resolve(path.dirname(resolvedExecutable), '..', 'Resources'));
    directCandidates.push(path.resolve(path.dirname(executablePath), '..', 'Resources'));
  }
  directCandidates.push(path.dirname(resolvedExecutable));
  directCandidates.push(path.dirname(executablePath));

  let ancestor = path.dirname(resolvedExecutable);
  for (let depth = 0; depth < 5; depth += 1) {
    directCandidates.push(ancestor);
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }

  const storeRoot = nixStoreRoot(resolvedExecutable) ?? nixStoreRoot(executablePath);
  if (storeRoot) {
    directCandidates.push(
      storeRoot,
      path.join(storeRoot, 'lib', 'camoufox'),
      path.join(storeRoot, 'libexec', 'camoufox'),
      path.join(storeRoot, 'share', 'camoufox'),
      path.join(storeRoot, 'opt', 'camoufox')
    );
  }

  for (const dir of directCandidates) {
    if (existsSync(path.join(dir, 'properties.json'))) return dir;
  }

  if (storeRoot) {
    for (const dir of collectDirs(storeRoot)) {
      if (existsSync(path.join(dir, 'properties.json'))) return dir;
    }
  }

  return null;
}

function findVersionFile(executablePath: string, resourceDirectory: string): string | null {
  const candidates = [
    path.join(resourceDirectory, 'version.json'),
    path.dirname(executablePath)
  ];
  let current = path.dirname(executablePath);
  for (let depth = 0; depth < 7; depth += 1) {
    const versionCandidate = path.join(current, 'version.json');
    if (existsSync(versionCandidate)) return versionCandidate;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const candidate of candidates) {
    if (candidate.endsWith('version.json') && existsSync(candidate)) return candidate;
  }
  return null;
}

function ensureSymlink(target: string, linkPath: string, type: 'file' | 'dir' = 'file'): void {
  rmSync(linkPath, { force: true, recursive: true });
  mkdirSync(path.dirname(linkPath), { recursive: true });
  symlinkSync(target, linkPath, process.platform === 'win32' && type === 'dir' ? 'junction' : type);
}

function ensureExternalBundleInstallDirectory(
  resolvedExecutable: string,
  resourceDirectory: string,
  versionFile: string | null
): string | null {
  const propertiesFile = path.join(resourceDirectory, 'properties.json');
  if (!existsSync(propertiesFile)) return null;

  const key = crypto
    .createHash('sha256')
    .update(`${resolvedExecutable}\n${realpathSync(resourceDirectory)}`)
    .digest('hex')
    .slice(0, 16);
  const shimDir = path.join(os.tmpdir(), 'causyne-browser-runtime', key);
  const cacheVersion = path.join(shimDir, 'version.json');
  const cacheProperties = path.join(shimDir, 'properties.json');
  const cacheFontconfig = path.join(shimDir, 'fontconfig');
  const cacheExecutable = expectedExecutable(shimDir);

  mkdirSync(shimDir, { recursive: true });

  if (!existsSync(cacheVersion)) {
    if (versionFile && existsSync(versionFile)) {
      writeFileSync(cacheVersion, readFileSync(versionFile));
    } else {
      writeFileSync(cacheVersion, JSON.stringify({ version: 'external', build: 'local' }), 'utf8');
    }
  }

  if (!existsSync(cacheProperties)) {
    ensureSymlink(realpathSync(propertiesFile), cacheProperties, 'file');
  }

  const sourceFontconfig = path.join(resourceDirectory, 'fontconfig');
  if (existsSync(sourceFontconfig) && !existsSync(cacheFontconfig)) {
    ensureSymlink(realpathSync(sourceFontconfig), cacheFontconfig, 'dir');
  }

  if (process.platform === 'darwin') {
    const appResourceDir = path.join(shimDir, 'Camoufox.app', 'Contents', 'Resources');
    mkdirSync(appResourceDir, { recursive: true });
    const appProperties = path.join(appResourceDir, 'properties.json');
    if (!existsSync(appProperties)) {
      ensureSymlink(realpathSync(propertiesFile), appProperties, 'file');
    }
    if (existsSync(sourceFontconfig) && !existsSync(path.join(appResourceDir, 'fontconfig'))) {
      ensureSymlink(realpathSync(sourceFontconfig), path.join(appResourceDir, 'fontconfig'), 'dir');
    }
  }

  if (!existsSync(cacheExecutable)) {
    ensureSymlink(resolvedExecutable, cacheExecutable, 'file');
  }

  return shimDir;
}

function ensureLaunchShim(resolvedExecutable: string, resourceDirectory: string): string {
  const key = crypto
    .createHash('sha256')
    .update(`${resolvedExecutable}\n${realpathSync(resourceDirectory)}`)
    .digest('hex')
    .slice(0, 16);
  const shimRoot = path.join(os.tmpdir(), 'causyne-browser-launch-shim', key);
  mkdirSync(shimRoot, { recursive: true });

  const shimExecutable = path.join(shimRoot, process.platform === 'win32' ? 'camoufox.exe' : 'camoufox-bin');
  ensureSymlink(resolvedExecutable, shimExecutable, 'file');

  for (const name of ['properties.json', 'version.json']) {
    const target = path.join(resourceDirectory, name);
    if (existsSync(target)) {
      ensureSymlink(realpathSync(target), path.join(shimRoot, name), 'file');
    }
  }

  const fontconfig = path.join(resourceDirectory, 'fontconfig');
  if (existsSync(fontconfig)) {
    ensureSymlink(realpathSync(fontconfig), path.join(shimRoot, 'fontconfig'), 'dir');
  }

  return shimExecutable;
}

/** Discover existing installations only. Never downloads or uses a personal profile. */
export function resolveChromiumRuntime(configured?: string): PreparedBrowserRuntime | null {
  const candidates = configured ? [configured] : process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
    : process.platform === 'win32'
      ? [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA].filter((root): root is string => Boolean(root)).flatMap(root => [path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'), path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe')])
      : ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/opt/google/chrome/chrome'];
  for (const candidate of candidates) {
    try {
      assertExecutable(candidate);
      return { engine: 'chromium', executablePath: candidate, installDirectory: path.dirname(candidate), resourceDirectory: path.dirname(candidate), source: configured ? 'environment' : 'system' };
    } catch { /* Try the next existing installation. */ }
  }
  return null;
}

export function resolveBrowserRuntime(): PreparedBrowserRuntime {
  const configured = process.env.CAUSYNE_BROWSER_EXECUTABLE?.trim()
    || process.env.CAMOUFOX_EXECUTABLE_PATH?.trim();
  const candidates = configured
    ? [resolveCandidateExecutablePath(path.resolve(configured))]
    : candidateExecutables().map(resolveCandidateExecutablePath);
  const executablePath = candidates.find(existsSync);
  if (configured && /(?:chrome|chromium|msedge)(?:\.exe)?$/i.test(path.basename(configured))) {
    const chromium = resolveChromiumRuntime(configured);
    if (chromium) return chromium;
  }
  if (!executablePath) {
    const chromium = !configured ? resolveChromiumRuntime() : null;
    if (chromium) return chromium;
    throw new Error(
      'Causyne Browser runtime is not installed. Causyne does not download browser binaries automatically. ' +
      'Install a supported browser runtime separately, then set CAUSYNE_BROWSER_EXECUTABLE to its executable path.'
    );
  }

  assertExecutable(executablePath);
  const resolvedExecutable = realpathSync(executablePath);
  const resourceDirectory = findResourceDirectory(executablePath, resolvedExecutable);
  if (!resourceDirectory) {
    throw new Error(
      `Causyne Browser runtime metadata (properties.json) was not found for ${resolvedExecutable}. ` +
      'Keep properties.json beside its platform bundle and point CAUSYNE_BROWSER_EXECUTABLE at that bundle.'
    );
  }

  let installDirectory = findInstallDirectory(resolvedExecutable);
  if (!installDirectory) {
    const versionFile = findVersionFile(resolvedExecutable, resourceDirectory);
    installDirectory = ensureExternalBundleInstallDirectory(resolvedExecutable, resourceDirectory, versionFile);
  }

  if (!installDirectory) {
    throw new Error(
      `Causyne Browser runtime at ${resolvedExecutable} is not a complete distribution. ` +
      'Keep version.json and properties.json beside its platform bundle and point CAUSYNE_BROWSER_EXECUTABLE at that bundle.'
    );
  }

  let launchExecutable = resolvedExecutable;
  try {
    launchExecutable = ensureLaunchShim(resolvedExecutable, resourceDirectory);
  } catch {
    launchExecutable = resolvedExecutable;
  }

  return {
    installDirectory,
    resourceDirectory,
    executablePath: launchExecutable,
    source: configured ? 'environment' : 'system'
  };
}

/**
 * Synchronously checks if a valid Causyne / Camoufox browser executable exists.
 */
export function isBrowserRuntimeInstalled(): boolean {
  try {
    const configured = process.env.CAUSYNE_BROWSER_EXECUTABLE?.trim()
      || process.env.CAMOUFOX_EXECUTABLE_PATH?.trim();
    const candidates = configured
      ? [resolveCandidateExecutablePath(path.resolve(configured))]
      : candidateExecutables().map(resolveCandidateExecutablePath);
    // Match launch-time discovery: Chromium is a supported installed runtime
    // too. The former Camoufox-only check suppressed host verification even
    // when resolveBrowserRuntime could launch the installed Chrome browser.
    if (configured && /(?:chrome|chromium|msedge)(?:\.exe)?$/i.test(path.basename(configured))) {
      return resolveChromiumRuntime(path.resolve(configured)) !== null;
    }
    return candidates.some(candidate => {
      try {
        assertExecutable(candidate);
        return Boolean(findResourceDirectory(candidate, realpathSync(candidate)));
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}
