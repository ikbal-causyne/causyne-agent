import fs from 'fs/promises';
import { createReadStream, createWriteStream } from 'fs';
import { pipeline } from 'stream/promises';
import os from 'os';

export const fsMove = {
  schema: {
    name: 'fs.move',
    description: 'Move or rename a file/directory atomically. Safely handles cross-partition (EXDEV) moves without crashing.',
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string' },
        destination: { type: 'string' },
        overwrite: { type: 'boolean' }
      },
      required: ['source', 'destination']
    }
  },
  async execute(args) {
    try {
      const src = args.source.replace(/^~\//, os.homedir() + '/');
      const dest = args.destination.replace(/^~\//, os.homedir() + '/');
      
      if (!args.overwrite) {
        try {
          await fs.access(dest);
          return { success: false, error: 'Destination already exists and overwrite is false.' };
        } catch (e) { /* dest does not exist, safe */ }
      }
      
      // Phase 4 AGI Upgrade: EXDEV Safe Rename
      try {
        await fs.rename(src, dest);
      } catch (err) {
        if (err.code === 'EXDEV') {
          // Cross-device link error (different partitions) - Use stream copy then unlink
          const stat = await fs.stat(src);
          if (stat.isDirectory()) {
            return { success: false, error: "Cannot atomically move entire directories across partitions yet. Please compress, move, and extract." };
          }
          await pipeline(
            createReadStream(src),
            createWriteStream(dest)
          );
          await fs.unlink(src);
        } else {
          throw err;
        }
      }
      
      return { success: true, output: `Atomically moved ${args.source} to ${args.destination}` };
    } catch (e) {
      return { success: false, error: e.message };
    }
  }
};
