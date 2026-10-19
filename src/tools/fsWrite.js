import fs from 'fs/promises';
import path from 'path';
import os from 'os';

export const fsWrite = {
  schema: {
    name: 'fs.write',
    description: 'Create or overwrite a file with content using Zero-Corruption Atomic Swap. Guarantees safe file writing.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        createDirectories: { type: 'boolean' }
      },
      required: ['path', 'content']
    }
  },
  async execute(args) {
    try {
      const target = args.path.replace(/^~\//, os.homedir() + '/');
      
      if (args.createDirectories !== false) {
        await fs.mkdir(path.dirname(target), { recursive: true });
      }

      // Phase 4 AGI Upgrade: Atomic File Swap
      // Prevent zero-byte file corruption if Node crashes during a huge write.
      const tempPath = `${target}.causyne_tmp_${Date.now()}`;
      
      await fs.writeFile(tempPath, args.content, 'utf8');
      
      // Atomic rename (POSIX standard guarantee)
      await fs.rename(tempPath, target);
      
      return { success: true, output: `Atomically wrote ${Buffer.byteLength(args.content, 'utf8')} bytes to ${args.path}` };
    } catch (e) {
      return { success: false, error: `Atomic Write Failed: ${e.message}` };
    }
  }
};
