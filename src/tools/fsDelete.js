import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { ensureCapability, loadCapabilityPackage } from '../provisioning/capabilityProvisioner.js';

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
  async execute(args) {
    try {
      const target = args.path.replace(/^~\//, os.homedir() + '/');
      
      const stats = await fs.stat(target);
      if (stats.isDirectory() && !args.recursive) {
        return { success: false, error: 'Target is a directory. recursive must be true' };
      }
      
      // Phase 4 AGI Upgrade: OS-level Trash Hook
      try {
        // The OS recycle bin is the safest delete, so it is tried first. When
        // the capability is not provisioned this throws and the rename fallback
        // below takes over — a real fallback, not a fabricated success.
        const capability = await ensureCapability('desktop');
        if (!capability.ok) throw new Error(capability.reason);
        const trash = await loadCapabilityPackage('trash');
        await trash([target]);
        return { success: true, output: `Moved ${args.path} to OS Trash/Recycle Bin.` };
      } catch (e) {
        // Fallback: Safe Rename (Virtual Trash)
        const trashDir = path.dirname(target);
        const trashName = `.causyne_trash_${Date.now()}_${path.basename(target)}`;
        const trashPath = path.join(trashDir, trashName);
        
        await fs.rename(target, trashPath);
        return { success: true, output: `OS recycle bin unavailable; used the safe-rename fallback: moved ${args.path} to ${trashPath}` };
      }
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
};
