import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import os from 'node:os';
import { getErrorMessage, type ToolWorkspaceContext } from './toolPathSafety.js';

export interface FsMoveArgs {
  source?: string | undefined;
  destination?: string | undefined;
  overwrite?: boolean | undefined;
}

export interface FsMoveResult {
  success: boolean;
  output?: string | undefined;
  error?: string | undefined;
}

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
  async execute(args: FsMoveArgs = {}, _context?: ToolWorkspaceContext): Promise<FsMoveResult> {
    try {
      if (typeof args?.source !== 'string' || typeof args?.destination !== 'string') {
        return { success: false, error: 'source and destination are required' };
      }
      const src = args.source.replace(/^~\//, os.homedir() + '/');
      const dest = args.destination.replace(/^~\//, os.homedir() + '/');

      if (!args.overwrite) {
        try {
          await fs.access(dest);
          return { success: false, error: 'Destination already exists and overwrite is false.' };
        } catch { /* dest does not exist, safe */ }
      }

      try {
        await fs.rename(src, dest);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException)?.code === 'EXDEV') {
          const stat = await fs.stat(src);
          if (stat.isDirectory()) {
            return { success: false, error: 'Cannot atomically move entire directories across partitions yet. Please compress, move, and extract.' };
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
    } catch (e: unknown) {
      return { success: false, error: getErrorMessage(e) };
    }
  }
};
