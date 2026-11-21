import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { getErrorMessage, assertSafeWorkspaceOutput, resolveScopedPath, sanitizeToolError, sanitizeToolText } from './toolPathSafety.js';
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
    async execute(args = {}, context) {
        try {
            const src = resolveScopedPath(args?.source, context);
            const dest = await assertSafeWorkspaceOutput(args?.destination, context);
            if (src === dest) {
                return { success: false, error: 'Source and destination refer to the same path.' };
            }
            const srcStat = await fs.lstat(src);
            const destStat = await fs.lstat(dest).catch((err) => {
                if (err.code === 'ENOENT')
                    return null;
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
            }
            catch (err) {
                if (err?.code === 'EXDEV') {
                    if (srcStat.isSymbolicLink() || !srcStat.isFile()) {
                        return { success: false, error: 'Cross-partition move supports regular files only.' };
                    }
                    const tempDest = `${dest}.part-${process.pid}-${Date.now()}`;
                    try {
                        await pipeline(createReadStream(src), createWriteStream(tempDest, { flags: 'wx', mode: 0o600 }));
                        await fs.rename(tempDest, dest);
                    }
                    catch (copyErr) {
                        await fs.unlink(tempDest).catch(() => { });
                        throw copyErr;
                    }
                    await fs.unlink(src);
                }
                else {
                    throw err;
                }
            }
            return { success: true, output: `Atomically moved ${sanitizeToolText(path.basename(src), 120)} to ${sanitizeToolText(path.basename(dest), 120)}` };
        }
        catch (e) {
            return { success: false, error: sanitizeToolError(e) };
        }
    }
};
