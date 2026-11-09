import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
function expandHome(value) {
    return value === '~' ? os.homedir()
        : value.startsWith('~/') || value.startsWith('~\\')
            ? path.join(os.homedir(), value.slice(2))
            : value;
}
function inside(root, target) {
    const relative = path.relative(root, target);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relative));
}
async function physicalTarget(target) {
    // Resolves symlinks in the longest existing ancestor, including a symlinked
    // parent of a new file. It is not a substitute for OS-level isolation.
    let current = target;
    const missing = [];
    while (true) {
        try {
            const resolved = await fs.realpath(current);
            return path.join(resolved, ...missing.reverse());
        }
        catch (error) {
            if (error?.code !== 'ENOENT')
                throw error;
            const parent = path.dirname(current);
            if (parent === current)
                throw new Error('Could not resolve target ancestry');
            missing.push(path.basename(current));
            current = parent;
        }
    }
}
async function checkScope(target, context) {
    if (!context || context.grantAllAccess === true)
        return;
    const roots = Array.isArray(context.workspacePaths) && context.workspacePaths.length > 0
        ? context.workspacePaths
        : [context.parentLoop?.workspaceRoot, context.workspaceRoot].filter((value) => typeof value === 'string' && value.length > 0);
    if (roots.length === 0)
        return;
    const physical = await physicalTarget(target);
    for (const root of roots) {
        try {
            const resolvedRoot = await fs.realpath(path.resolve(expandHome(root)));
            if (inside(resolvedRoot, physical))
                return;
        }
        catch { /* A non-existent authorized root is not permission to escape. */ }
    }
    throw new Error(`Target resolves outside the selected workspace: ${target}`);
}
function writeError(error, target) {
    const code = error?.code;
    if (code === 'EISDIR' || code === 'ENOTEMPTY') {
        return `Cannot write file: "${target}" is an existing directory. Supply a filename inside it, such as ${path.join(target, 'index.html')}.`;
    }
    return `Atomic file write failed: ${error instanceof Error ? error.message : String(error)}`;
}
export const fsWrite = {
    schema: {
        name: 'fs.write',
        description: 'Write a complete UTF-8 file using atomic rename. Path must be a file, not a directory.',
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
    async execute(args, context) {
        if (!args || typeof args.path !== 'string' || !args.path.trim()) {
            return { success: false, error: 'fs_write requires a nonempty path pointing to a FILE.' };
        }
        if (typeof args.content !== 'string') {
            return { success: false, error: 'fs_write requires content as a string. Do not infer or invent missing file content.' };
        }
        if (args.path.endsWith('/') || args.path.endsWith('\\')) {
            return { success: false, error: `Target ${args.path} ends in a directory separator. Add a filename such as index.html.` };
        }
        const target = path.resolve(expandHome(args.path.trim()));
        let temporary = '';
        try {
            await checkScope(target, context);
            let originalMode;
            try {
                const stat = await fs.lstat(target);
                if (stat.isDirectory()) {
                    return { success: false, error: `Cannot write file: "${target}" is an existing directory. Specify a target file path inside this directory (e.g. "${path.join(target, 'index.html')}").` };
                }
                if (stat.isSymbolicLink()) {
                    return { success: false, error: `Refusing to replace symbolic link ${target}; use a regular file in the selected workspace.` };
                }
                if (!stat.isFile()) {
                    return { success: false, error: `Target ${target} is not a regular file.` };
                }
                originalMode = stat.mode & 0o777;
            }
            catch (error) {
                if (error?.code !== 'ENOENT')
                    throw error;
            }
            if (args.createDirectories !== false) {
                await fs.mkdir(path.dirname(target), { recursive: true });
            }
            // Re-check after creating parents: an existing parent might be a symlink.
            await checkScope(target, context);
            temporary = path.join(path.dirname(target), `.${path.basename(target)}.causyne-${randomUUID()}.tmp`);
            const file = await fs.open(temporary, 'wx', originalMode ?? 0o600);
            try {
                await file.writeFile(args.content, { encoding: 'utf8' });
                await file.sync();
            }
            finally {
                await file.close();
            }
            // Never reinterpret a directory as a file if the destination changed.
            const destinationStat = await fs.lstat(target).catch((error) => {
                if (error.code === 'ENOENT')
                    return null;
                throw error;
            });
            if (destinationStat && !destinationStat.isFile()) {
                throw new Error(`Destination is no longer a regular file: ${target}`);
            }
            await checkScope(target, context);
            await fs.rename(temporary, target);
            temporary = '';
            // Flushing the parent directory is best effort: some platforms disallow it.
            try {
                const directory = await fs.open(path.dirname(target), 'r');
                try {
                    await directory.sync();
                }
                finally {
                    await directory.close();
                }
            }
            catch { /* Do not claim crash-durable guarantees on unsupported FS. */ }
            return {
                success: true,
                output: `Wrote ${Buffer.byteLength(args.content, 'utf8')} bytes to ${target}`
            };
        }
        catch (error) {
            return { success: false, error: writeError(error, target) };
        }
        finally {
            if (temporary)
                await fs.unlink(temporary).catch(() => { });
        }
    }
};
