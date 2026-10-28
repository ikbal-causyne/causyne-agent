import fs from 'node:fs';
import path from 'node:path';
import { causyneHome } from './utils/paths.js';

/** Read only an exact output file already attached to this session's history. */
export function isOutputRecoveryRead(tool: string, target: unknown, knownPaths: ReadonlySet<string>): boolean {
  if (tool !== 'fs_read' || typeof target !== 'string') return false;
  const resolved = path.resolve(target);
  if (!knownPaths.has(resolved)) return false;
  try {
    const stat = fs.lstatSync(resolved);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    const real = fs.realpathSync(resolved);
    return ['outputs', 'tool-output'].some(directory => {
      const root = path.join(causyneHome(), directory);
      if (!fs.existsSync(root)) return false;
      const relative = path.relative(fs.realpathSync(root), real);
      return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    });
  } catch { return false; }
}
