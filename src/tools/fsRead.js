import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import os from 'node:os';
function expandHomePath(raw) {
    const trimmed = raw.trim();
    if (trimmed === '~')
        return os.homedir();
    if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
        return path.join(os.homedir(), trimmed.slice(2));
    }
    return trimmed;
}
function isWithinRoot(root, candidate) {
    const rel = path.relative(root, candidate);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}
function checkReadScope(target, context) {
    if (!context || context.grantAllAccess === true)
        return null;
    const configured = Array.isArray(context.workspacePaths)
        ? context.workspacePaths.filter((p) => typeof p === 'string' && p.trim().length > 0).map(p => p.trim())
        : [];
    const roots = configured.length > 0
        ? configured
        : [context.parentLoop?.workspaceRoot, context.workspaceRoot]
            .filter((p) => typeof p === 'string' && p.trim().length > 0)
            .map(p => p.trim());
    if (roots.length === 0)
        return null;
    let realTarget;
    try {
        realTarget = fs.realpathSync(target);
    }
    catch {
        return null;
    }
    for (const root of roots) {
        try {
            const realRoot = fs.realpathSync(path.resolve(expandHomePath(root)));
            if (isWithinRoot(realRoot, realTarget))
                return null;
        }
        catch {
            continue;
        }
    }
    return `Target resolves outside the selected workspace: ${target}`;
}
const BINARY_EXTENSIONS = /\.(png|jpe?g|webp|gif|svg|bmp|ico|blend\d?|glb|gltf|wasm|zip|tar|gz|bz2|xz|7z|rar|mp4|mov|avi|mkv|webm|mp3|wav|ogg|flac|aac|m4a|pdf|exe|dll|dylib|so|bin|iso|dmg)$/i;
/** Fast Binary Detection: inspect the first 1024 bytes for a null byte. */
async function isBinary(filePath) {
    let fd = null;
    try {
        fd = await fs.promises.open(filePath, 'r');
        const buffer = Buffer.alloc(1024);
        const { bytesRead } = await fd.read(buffer, 0, 1024, 0);
        for (let i = 0; i < bytesRead; i++) {
            if (buffer[i] === 0)
                return true;
        }
        return false;
    }
    catch {
        return false;
    }
    finally {
        if (fd) {
            await fd.close().catch(() => { });
        }
    }
}
export const fsRead = {
    schema: {
        name: 'fs.read',
        description: 'Read file contents intelligently. Automatically pages large files to protect Context Window.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string' },
                startLine: { type: 'number' },
                endLine: { type: 'number' }
            },
            required: ['path']
        }
    },
    async execute(args, context) {
        try {
            if (!args || typeof args.path !== 'string' || !args.path.trim()) {
                return { success: false, error: 'Missing required parameter: path' };
            }
            const expanded = expandHomePath(args.path);
            const baseRoot = context?.parentLoop?.workspaceRoot?.trim()
                || context?.workspaceRoot?.trim()
                || context?.workspacePaths?.find((p) => typeof p === 'string' && p.trim().length > 0)?.trim();
            const target = path.isAbsolute(expanded)
                ? path.resolve(expanded)
                : path.resolve(baseRoot ? path.resolve(expandHomePath(baseRoot)) : process.cwd(), expanded);
            if (!fs.existsSync(target)) {
                return { success: false, error: 'File does not exist.' };
            }
            const scopeErr = checkReadScope(target, context);
            if (scopeErr) {
                return { success: false, error: scopeErr };
            }
            const targetStat = fs.statSync(target);
            if (targetStat.isDirectory()) {
                return { success: false, error: `Path is a directory, not a file: ${target}. Use fs_list to inspect directories.` };
            }
            if (!targetStat.isFile()) {
                return { success: false, error: `Path is not a regular readable file: ${target}` };
            }
            const ext = path.extname(target).toLowerCase();
            const isKnownBinaryExt = BINARY_EXTENSIONS.test(ext);
            // Fast check for binary media/executables to prevent token context blowup
            if (isKnownBinaryExt || (await isBinary(target))) {
                let stat = null;
                try {
                    stat = fs.statSync(target);
                }
                catch {
                    // ignore stat error
                }
                const sizeStr = stat ? `${(stat.size / 1024).toFixed(1)} KB` : 'unknown size';
                const isImage = /\.(png|jpe?g|webp|gif|svg|bmp|ico)$/i.test(ext);
                return {
                    success: false,
                    isBinary: true,
                    error: isImage
                        ? `Cannot read image file '${path.basename(target)}' as plain text. Use view_image (or vision inspection). File metadata: ${sizeStr}, format: ${ext.replace('.', '').toUpperCase() || 'IMAGE'}.`
                        : `Cannot read binary file '${path.basename(target)}' as plain text. File size: ${sizeStr}.`
                };
            }
            const start = typeof args.startLine === 'number' && Number.isFinite(args.startLine) && args.startLine > 0 ? Math.floor(args.startLine) : 1;
            let end = typeof args.endLine === 'number' && Number.isFinite(args.endLine) && args.endLine >= start ? Math.floor(args.endLine) : start + 799;
            // Mandatory Paging Limit: at most 800 lines per read to preserve context
            if (end - start + 1 > 800) {
                end = start + 799;
            }
            let currentLine = 1;
            const outputLines = [];
            let totalLines = 0;
            const stream = fs.createReadStream(target);
            const rl = readline.createInterface({
                input: stream,
                crlfDelay: Infinity
            });
            try {
                for await (const line of rl) {
                    if (context?.signal?.aborted) {
                        return { success: false, error: 'File read aborted.' };
                    }
                    totalLines++;
                    if (currentLine >= start && currentLine <= end) {
                        outputLines.push(line);
                    }
                    currentLine++;
                }
            }
            finally {
                rl.close();
                stream.destroy();
            }
            let finalOutput = outputLines.join('\n');
            if (totalLines > end) {
                finalOutput += `\n\n[WARNING: File truncated at line ${end} out of ${totalLines}. Use { startLine: ${end + 1}, endLine: ${end + 800} } to read more.]`;
            }
            return { success: true, output: finalOutput };
        }
        catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return { success: false, error: msg };
        }
    }
};
