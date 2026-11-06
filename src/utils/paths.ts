import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function isTempHome(dir: string): boolean {
  const normalized = path.resolve(dir);
  const tmp = path.resolve(os.tmpdir());
  return (
    normalized.startsWith(tmp) ||
    normalized.startsWith('/tmp/') ||
    normalized.startsWith('/private/tmp/') ||
    normalized.startsWith('/var/folders/') ||
    normalized.startsWith('/private/var/folders/')
  );
}

function isNodeTestRunner(): boolean {
  if (process.env['NODE_TEST_CONTEXT']) return true;
  return process.execArgv.some((arg) => arg === '--test' || arg.startsWith('--test-'));
}

/**
 * Resolve a path the model supplied, expanding a leading `~`.
 *
 * WHY THIS EXISTS. `path.resolve('~/x')` does NOT expand the tilde — it treats
 * `~` as an ordinary directory name and returns `<cwd>/~/x`. Models write `~/`
 * constantly, because that is how paths are written everywhere they have ever
 * read one, and because Causyne's own transcript SHOWS paths that way.
 *
 * It cost a real run: `view_image ~/Causyne/pen_cinematic/preview.png` failed in
 * 17ms with "Image not found at /Users/example/project/~/project/..."
 * on a file that existed — the agent had just rendered it and was trying to
 * look at its own work, which is the one step that separates a good render from
 * a bad one.
 *
 * @param input A path, possibly starting with `~`.
 * @returns An absolute path.
 */
export function resolveUserPath(input: string): string {
  const raw = String(input ?? '').trim();
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/') || raw.startsWith('~\\')) {
    return path.resolve(path.join(os.homedir(), raw.slice(2)));
  }
  return path.resolve(raw);
}

export function causyneHome(): string {
  const envHome = process.env['CAUSYNE_HOME'];
  if (envHome && String(envHome).trim()) {
    return path.resolve(String(envHome).trim());
  }
  const home = os.homedir();
  if (isNodeTestRunner() && !isTempHome(home)) {
    const fallbackRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-test-auto-'));
    process.env['CAUSYNE_HOME'] = fallbackRoot;
    process.once('exit', () => {
      try {
        fs.rmSync(fallbackRoot, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup
      }
    });
    return fallbackRoot;
  }
  return path.join(home, '.causyne');
}
