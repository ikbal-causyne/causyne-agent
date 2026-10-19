import os from 'os';
import path from 'path';

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
 * @param   {string} input  A path, possibly starting with `~`.
 * @returns {string}        An absolute path.
 */
export function resolveUserPath(input) {
  const raw = String(input ?? '').trim();
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/') || raw.startsWith('~\\')) {
    return path.resolve(path.join(os.homedir(), raw.slice(2)));
  }
  return path.resolve(raw);
}


const STATE_ROOT = process.env.CAUSYNE_HOME && String(process.env.CAUSYNE_HOME).trim()
  ? path.resolve(String(process.env.CAUSYNE_HOME).trim())
  : path.join(os.homedir(), '.causyne');

export function causyneHome() {
  return STATE_ROOT;
}
