import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import {
  getErrorMessage,
  assertSafeWorkspaceOutput,
  resolveScopedPath,
  sanitizeToolError,
  sanitizeToolText,
  type ToolWorkspaceContext
} from './toolPathSafety.js';

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
  async execute(args: FsMoveArgs = {}, context?: ToolWorkspaceContext): Promise<FsMoveResult> {
    try {
      const src = resolveScopedPath(args?.source, context);
      const dest = await assertSafeWorkspaceOutput(args?.destination, context);
      if (src === dest) {
        return { success: false, error: 'Source and destination refer to the same path.' };
      }
      const srcStat = await fs.lstat(src);

      const destStat = await fs.lstat(dest).catch((err: NodeJS.ErrnoException) => {
        if (err.code === 'ENOENT') return null;
        throw err;
      });
      if (destStat) {
        if (!args?.overwrite) {
          return { success: false, error: 'Destination already exists and overwrite is false.' };
        }
        if (destStat.isSymbolicLink() || destStat.isDirectory()) {
          return { success: false, error: 'Refusing to overwrite symlink or directory destination.' };
        }
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
