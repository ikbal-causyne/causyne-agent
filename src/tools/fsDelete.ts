import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensureCapability, loadCapabilityPackage } from '../provisioning/capabilityProvisioner.js';
import { isBlockedWorkspaceRoot } from '../sandboxPolicy.js';
import {
  getErrorMessage,
  resolveScopedPath,
  resolveToolWorkspaceRoots,
  sanitizeToolError,
  sanitizeToolText,
  type ToolWorkspaceContext
} from './toolPathSafety.js';

export interface FsDeleteArgs {
  path?: string | undefined;
  recursive?: boolean | undefined;
}

export interface FsDeleteResult {
  success: boolean;
  output?: string | undefined;
  error?: string | undefined;
}

export const fsDelete = {
  schema: {
    name: 'fs.delete',
    description: 'Safely delete a file or directory. Integrates with OS Trash/Bin to prevent catastrophic data loss. No permanent rm -rf.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        recursive: { type: 'boolean' }
      },
      required: ['path']
    }
  },
  async execute(args: FsDeleteArgs = {}, context?: ToolWorkspaceContext): Promise<FsDeleteResult> {
    try {
      const target = resolveScopedPath(args?.path, context);
      if (isBlockedWorkspaceRoot(target)) {
        return { success: false, error: 'Refusing to delete a protected system root directory.' };
      }
      const scope = resolveToolWorkspaceRoots(context);
      if (scope.roots.some((root) => path.resolve(root) === target)) {
        return { success: false, error: 'Refusing to delete the workspace root directory itself.' };
      }

      const stats = await fs.lstat(target);
      if (stats.isDirectory() && !args?.recursive) {
        return { success: false, error: 'Target is a directory. recursive must be true' };
      }

      try {
        const capability = await ensureCapability('desktop');
        if (!capability.ok) throw new Error(capability.reason);
        const trash = await loadCapabilityPackage('trash') as (paths: string[]) => Promise<void>;
        await trash([target]);
        return { success: true, output: `Moved ${args.path} to OS Trash/Recycle Bin.` };
      } catch {
        const trashDir = path.dirname(target);
        const trashName = `.causyne_trash_${Date.now()}_${path.basename(target)}`;
        const trashPath = path.join(trashDir, trashName);

        await fs.rename(target, trashPath);
        return { success: true, output: `OS recycle bin unavailable; used the safe-rename fallback: moved ${args.path} to ${trashPath}` };
      }
    } catch (e: unknown) {
      return { success: false, error: getErrorMessage(e) };
    }
  }
};
