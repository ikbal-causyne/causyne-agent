import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Adapted from Jo Inc's MIT-licensed Camofox Browser external executable
// discovery at commit 2c0036a8b18bf9cd983376751ff4d52dfd9add0f. Causyne
// keeps this integration layer in TypeScript and never downloads a browser.

export interface PreparedCamoufoxRuntime {
  installDirectory: string;
  resourceDirectory: string;
  source: 'environment' | 'system';
}

function assertExecutable(candidate: string): void {
  const stat = statSync(candidate);
  if (!stat.isFile() && !stat.isSymbolicLink()) {
    throw new Error(`Camoufox executable is not a file: ${candidate}`);
  }
  if (process.platform !== 'win32') accessSync(candidate, constants.X_OK);
}

function candidateExecutables(): string[] {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return [
      path.join(home, 'Library', 'Caches', 'camoufox', 'Camoufox.app', 'Contents', 'MacOS', 'camoufox'),
      '/Applications/Camoufox.app/Contents/MacOS/camoufox',
      path.join(home, 'Applications', 'Camoufox.app', 'Contents', 'MacOS', 'camoufox')
    ];
  }
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA;
    const programFiles = process.env.ProgramFiles;
    return [
      ...(localAppData ? [path.join(localAppData, 'camoufox', 'camoufox.exe')] : []),
      ...(localAppData ? [path.join(localAppData, 'Camoufox', 'camoufox.exe')] : []),
      ...(programFiles ? [path.join(programFiles, 'Camoufox', 'camoufox.exe')] : [])
    ];
  }
  return [
    path.join(home, '.cache', 'camoufox', 'camoufox-bin'),
    '/opt/camoufox/camoufox-bin',
    path.join(home, '.local', 'share', 'camoufox', 'camoufox-bin'),
    '/usr/local/lib/camoufox/camoufox-bin'
  ];
}

function expectedExecutable(installDirectory: string): string {
  if (process.platform === 'darwin') {
    return path.join(installDirectory, 'Camoufox.app', 'Contents', 'MacOS', 'camoufox');
  }
  if (process.platform === 'win32') return path.join(installDirectory, 'camoufox.exe');
  return path.join(installDirectory, 'camoufox-bin');
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

function resourceDirectoryFor(executablePath: string): string {
  if (process.platform === 'darwin') {
    return path.resolve(path.dirname(executablePath), '..', 'Resources');
  }
  return path.dirname(executablePath);
}

export function resolveCamoufoxRuntime(): PreparedCamoufoxRuntime {
  const configured = process.env.CAUSYNE_CAMOFOX_EXECUTABLE?.trim();
  const configuredHome = process.env.CAMOUFOX_INSTALL_DIR?.trim();
  const candidates = configured
    ? [path.resolve(configured)]
    : configuredHome
      ? [expectedExecutable(path.resolve(configuredHome))]
      : candidateExecutables();
  const executablePath = candidates.find(existsSync);
  if (!executablePath) {
    throw new Error(
      'Camoufox is not installed. Causyne does not download browser binaries automatically. ' +
      'Install a trusted Camoufox build separately, then set CAUSYNE_CAMOFOX_EXECUTABLE to its executable path.'
    );
  }

  assertExecutable(executablePath);
  const resolvedExecutable = realpathSync(executablePath);
  const installDirectory = findInstallDirectory(resolvedExecutable);
  if (!installDirectory) {
    throw new Error(
      `Camoufox at ${resolvedExecutable} is not inside a complete distribution. ` +
      'Keep the distribution version.json beside its platform bundle and point CAUSYNE_CAMOFOX_EXECUTABLE at that bundle.'
    );
  }
  const resourceDirectory = resourceDirectoryFor(resolvedExecutable);
  if (!existsSync(path.join(resourceDirectory, 'properties.json'))) {
    throw new Error(`Camoufox properties.json was not found in ${resourceDirectory}.`);
  }

  return {
    installDirectory,
    resourceDirectory,
    source: configured || configuredHome ? 'environment' : 'system'
  };
}
