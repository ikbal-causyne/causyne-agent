import fs from 'node:fs/promises';
import path from 'node:path';

function within(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function scopedTarget(workspace, target) {
  const root = path.resolve(workspace);
  const resolved = path.resolve(target);
  if (root === resolved || !within(root, resolved)) throw new Error('File target must stay inside the selected workspace');
  return { root, resolved };
}

export async function ensureSafeWorkspaceOutputPath(workspace, target) {
  const { root, resolved } = scopedTarget(workspace, target);
  const realRoot = await fs.realpath(root);
  const relativeParent = path.relative(root, path.dirname(resolved));
  let current = root;
  for (const part of relativeParent.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      await fs.lstat(current);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      await fs.mkdir(current);
    }
    const realCurrent = await fs.realpath(current);
    if (!within(realRoot, realCurrent) || !(await fs.stat(current)).isDirectory()) {
      throw new Error('Output directory resolves outside the selected workspace');
    }
  }
  const existing = await fs.lstat(resolved).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
    throw new Error('Output target cannot be a symlink or directory');
  }
}

export async function ensureSafeWorkspaceInputPath(workspace, target) {
  const { root, resolved } = scopedTarget(workspace, target);
  const realRoot = await fs.realpath(root);
  const realTarget = await fs.realpath(resolved);
  if (!within(realRoot, realTarget) || !(await fs.stat(realTarget)).isFile()) {
    throw new Error('Upload file resolves outside the selected workspace or is not regular');
  }
}
