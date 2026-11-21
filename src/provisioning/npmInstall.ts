import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { sanitizeSubprocessEnv } from '../tools/subprocessEnv.js';
import { redactProviderSecrets } from '../providers/byokHttp.js';
import { safeDisplay } from '../tui/text.js';

/** Install optional capabilities without writing over the active terminal UI. */
export function installCapabilityManifest(directory: string): void {
  if (typeof directory !== 'string' || !directory.trim() || directory.includes('\0')) {
    throw new Error('Invalid capability installation directory');
  }
  const resolvedDir = path.resolve(directory);
  const dirStat = fs.lstatSync(resolvedDir);
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    throw new Error('Refusing symlink or non-directory capability installation target');
  }
  const manifestPath = path.join(resolvedDir, 'package.json');
  const manifestStat = fs.lstatSync(manifestPath);
  if (manifestStat.isSymbolicLink() || !manifestStat.isFile()) {
    throw new Error('Refusing missing, symlinked, or non-regular capability package.json');
  }
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  try {
    execFileSync(npm, ['install', '--ignore-scripts', '--no-fund'], {
      cwd: resolvedDir,
      stdio: 'pipe',
      encoding: 'utf8',
      maxBuffer: 2 * 1024 * 1024,
      timeout: 120_000,
      windowsHide: true,
      env: {
        ...sanitizeSubprocessEnv(process.env),
        npm_config_ignore_scripts: 'true',
        npm_config_fund: 'false',
        npm_config_audit: 'false'
      }
    });
  } catch (error: unknown) {
    const rawReason = error instanceof Error ? error.message : String(error);
    const reason = safeDisplay(redactProviderSecrets(rawReason)).slice(0, 600);
    throw new Error(`Capability installation failed: ${reason}`, { cause: error });
  }
}
