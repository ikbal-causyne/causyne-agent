import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
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
            // Prevent EISDIR if target path is already an existing directory
            try {
                const stat = await fs.stat(target);
                if (stat.isDirectory()) {
                    return {
                        success: false,
                        error: `Cannot write file: "${args.path}" is an existing directory. Specify a target file path inside this directory (e.g. "${args.path}/index.js").`
                    };
                }
            }
            catch {
                // Target does not exist yet, safe to proceed
            }
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
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return { success: false, error: `Atomic Write Failed: ${msg}` };
        }
    }
};
