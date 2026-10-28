import fs from 'node:fs';
import path from 'node:path';
import { causyneHome } from './utils/paths.js';

function normalizePathKey(filePath: string): string {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** Read only an exact output file already attached to this session's history. */
export function isOutputRecoveryRead(tool: string, target: unknown, knownPaths: ReadonlySet<string>): boolean {
  if (tool !== 'fs_read' || typeof target !== 'string') return false;
  const targetKey = normalizePathKey(target);
  const isKnown = Array.from(knownPaths).some(known => normalizePathKey(known) === targetKey);
  if (!isKnown) return false;

  try {
    const resolved = path.resolve(target);
    const stat = fs.lstatSync(resolved);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    const real = fs.realpathSync(resolved);
    const realKey = process.platform === 'win32' ? real.toLowerCase() : real;

    return ['outputs', 'tool-output'].some(directory => {
      const root = path.join(causyneHome(), directory);
      if (!fs.existsSync(root)) return false;
      const realRoot = fs.realpathSync(root);
      const rootKey = process.platform === 'win32' ? realRoot.toLowerCase() : realRoot;
      const relative = path.relative(rootKey, realKey);
      return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    });
  } catch { return false; }
}
