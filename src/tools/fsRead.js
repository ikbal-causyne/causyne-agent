import fs from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import os from 'node:os';
const BINARY_EXTENSIONS = /\.(png|jpe?g|webp|gif|svg|bmp|ico|blend\d?|glb|gltf|wasm|zip|tar|gz|bz2|xz|7z|rar|mp4|mov|avi|mkv|webm|mp3|wav|ogg|flac|aac|m4a|pdf|exe|dll|dylib|so|bin|iso|dmg)$/i;
/** Fast Binary Detection: inspect the first 1024 bytes for a null byte. */
async function isBinary(filePath) {
    try {
        const fd = await fs.promises.open(filePath, 'r');
        const buffer = Buffer.alloc(1024);
        const { bytesRead } = await fd.read(buffer, 0, 1024, 0);
        await fd.close();
        for (let i = 0; i < bytesRead; i++) {
            if (buffer[i] === 0)
                return true;
        }
        return false;
    }
    catch {
        return false;
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
    async execute(args) {
        try {
            if (!args || typeof args.path !== 'string' || !args.path.trim()) {
                return { success: false, error: 'Missing required parameter: path' };
            }
            const target = args.path.replace(/^~\//, os.homedir() + '/');
            if (!fs.existsSync(target)) {
                return { success: false, error: 'File does not exist.' };
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
            const start = typeof args.startLine === 'number' && args.startLine > 0 ? Math.floor(args.startLine) : 1;
            let end = typeof args.endLine === 'number' && args.endLine >= start ? Math.floor(args.endLine) : start + 799;
            // Mandatory Paging Limit: at most 800 lines per read to preserve context
            if (end - start + 1 > 800) {
                end = start + 799;
            }
            let currentLine = 1;
            const outputLines = [];
            let totalLines = 0;
            const rl = readline.createInterface({
                input: fs.createReadStream(target),
                crlfDelay: Infinity
            });
            for await (const line of rl) {
                totalLines++;
                if (currentLine >= start && currentLine <= end) {
                    outputLines.push(line);
                }
                currentLine++;
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
