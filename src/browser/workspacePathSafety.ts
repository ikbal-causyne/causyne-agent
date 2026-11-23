import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizePathForCompare, stripWindowsExtendedPrefix } from '../agent/workspaceBoundary.js';

function within(root: string, target: string): boolean {
  const relative = path.relative(normalizePathForCompare(root), normalizePathForCompare(target));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function scopedTarget(workspace: string, target: string): { root: string; resolved: string } {
  const root = path.resolve(stripWindowsExtendedPrefix(workspace));
  const resolved = path.resolve(stripWindowsExtendedPrefix(target));
  if (normalizePathForCompare(root) === normalizePathForCompare(resolved) || !within(root, resolved)) {
    throw new Error('File target must stay inside the selected workspace');
  }
  return { root, resolved };
}

export async function ensureSafeWorkspaceOutputPath(workspace: string, target: string): Promise<void> {
  const { root, resolved } = scopedTarget(workspace, target);
  const realRoot = await fs.realpath(root);
  const relativeParent = path.relative(root, path.dirname(resolved));
  let current = root;
  for (const part of relativeParent.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      await fs.lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await fs.mkdir(current);
    }
    const realCurrent = await fs.realpath(current);
    if (!within(realRoot, realCurrent) || !(await fs.stat(current)).isDirectory()) {
      throw new Error('Output directory resolves outside the selected workspace');
    }
  }
  const existing = await fs.lstat(resolved).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
    throw new Error('Output target cannot be a symlink or directory');
  }
}

export async function ensureSafeWorkspaceInputPath(workspace: string, target: string): Promise<void> {
  const { root, resolved } = scopedTarget(workspace, target);
  const realRoot = await fs.realpath(root);
  const realTarget = await fs.realpath(resolved);
  if (!within(realRoot, realTarget) || !(await fs.stat(realTarget)).isFile()) {
    throw new Error('Upload file resolves outside the selected workspace or is not regular');
  }
}
