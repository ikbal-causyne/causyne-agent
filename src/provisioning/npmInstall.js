import { execFileSync } from 'node:child_process';
/** Install optional capabilities without writing over the active terminal UI. */
export function installCapabilityManifest(directory) {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    try {
        execFileSync(npm, ['install', '--ignore-scripts', '--no-fund'], {
            cwd: directory,
            stdio: 'pipe',
            encoding: 'utf8',
            maxBuffer: 2 * 1024 * 1024,
            timeout: 120_000,
            windowsHide: true
        });
    }
    catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`Capability installation failed: ${reason.slice(0, 600)}`, { cause: error });
    }
}
