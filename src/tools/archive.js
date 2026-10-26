import fs from 'node:fs/promises';
import { existsSync, statSync, createWriteStream } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveUserPath } from '../utils/paths.js';
import { loadCapabilityPackage } from '../provisioning/capabilityProvisioner.js';
export const archive = {
    schema: {
        name: 'archive',
        description: 'Compress or extract archives securely with zero friction (supports .zip, .tar, .tar.gz, .tgz with native system fallbacks).',
        parameters: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['compress', 'extract'], description: 'Action to perform: "compress" or "extract"' },
                source: { type: 'string', description: 'Absolute or relative path of the file/directory to compress or extract' },
                destination: { type: 'string', description: 'Absolute or relative path for the output file or directory' }
            },
            required: ['action', 'source', 'destination']
        }
    },
    async execute(args) {
        try {
            if (!args || !args.action || !args.source || !args.destination) {
                return { success: false, error: 'Missing required arguments: action, source, destination' };
            }
            const source = resolveUserPath(args.source);
            const dest = resolveUserPath(args.destination);
            if (!existsSync(source)) {
                return { success: false, error: `Archive source path not found: ${source}` };
            }
            if (args.action === 'extract') {
                return await extractArchive(source, dest);
            }
            else if (args.action === 'compress') {
                return await compressArchive(source, dest);
            }
            else {
                return { success: false, error: `Unsupported archive action: ${args.action}` };
            }
        }
        catch (error) {
            return { success: false, error: `Archive action failed: ${error?.message || String(error)}` };
        }
    }
};
async function extractArchive(source, dest) {
    await fs.mkdir(dest, { recursive: true });
    // 1. Try capability package extract-zip if already available in environment
    try {
        const extract = await loadCapabilityPackage('extract-zip');
        if (typeof extract === 'function') {
            await extract(source, { dir: dest });
            return { success: true, output: `Extracted successfully to ${dest}` };
        }
    }
    catch {
        // Fall through to native zero-dependency extractors
    }
    const isZip = source.toLowerCase().endsWith('.zip') || source.toLowerCase().endsWith('.jar');
    const isTar = /\.(tar|tar\.gz|tgz|tar\.bz2|tar\.xz)$/i.test(source);
    // 2. Native unzip on macOS / Linux
    if (isZip) {
        try {
            execFileSync('unzip', ['-q', '-o', source, '-d', dest], { stdio: 'pipe' });
            return { success: true, output: `Extracted successfully to ${dest} (via unzip)` };
        }
        catch {
            // Fall through to python3 or powershell
        }
    }
    // 3. Native tar on macOS / Linux
    if (isTar || !isZip) {
        try {
            execFileSync('tar', ['-xf', source, '-C', dest], { stdio: 'pipe' });
            return { success: true, output: `Extracted successfully to ${dest} (via tar)` };
        }
        catch {
            // Fall through
        }
    }
    // 4. Cross-platform Python standard library fallback
    try {
        execFileSync('python3', [
            '-c',
            'import zipfile, tarfile, sys, os\n' +
                'src, dst = sys.argv[1], sys.argv[2]\n' +
                'if zipfile.is_zipfile(src):\n' +
                '    with zipfile.ZipFile(src, "r") as z:\n' +
                '        z.extractall(dst)\n' +
                'elif tarfile.is_tarfile(src):\n' +
                '    with tarfile.open(src, "r:*") as t:\n' +
                '        t.extractall(dst)\n' +
                'else:\n' +
                '    raise ValueError("Unrecognized archive format")\n',
            source,
            dest
        ], { stdio: 'pipe' });
        return { success: true, output: `Extracted successfully to ${dest} (via python3)` };
    }
    catch {
        // Fall through
    }
    // 5. Windows PowerShell fallback
    if (process.platform === 'win32') {
        try {
            const psScript = `Expand-Archive -Path '${source.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`;
            execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], { stdio: 'pipe' });
            return { success: true, output: `Extracted successfully to ${dest} (via PowerShell)` };
        }
        catch (e) {
            return { success: false, error: `PowerShell extraction failed: ${e.message}` };
        }
    }
    return { success: false, error: `Could not extract ${source}: no supported extractor found on system.` };
}
async function compressArchive(source, dest) {
    const destDir = path.dirname(dest);
    await fs.mkdir(destDir, { recursive: true });
    // 1. Try capability package archiver if available
    try {
        const archiver = await loadCapabilityPackage('archiver');
        if (typeof archiver === 'function') {
            return await new Promise(async (resolve) => {
                const output = createWriteStream(dest);
                const format = dest.toLowerCase().endsWith('.tar') || dest.toLowerCase().endsWith('.tar.gz') ? 'tar' : 'zip';
                const archiveStream = archiver(format, { zlib: { level: 9 } });
                output.on('close', () => resolve({ success: true, output: `Compressed ${archiveStream.pointer()} total bytes to ${dest}` }));
                archiveStream.on('error', (err) => resolve({ success: false, error: err.message }));
                archiveStream.pipe(output);
                const stat = statSync(source);
                if (stat.isDirectory()) {
                    archiveStream.directory(source, false);
                }
                else {
                    archiveStream.file(source, { name: path.basename(source) });
                }
                await archiveStream.finalize();
            });
        }
    }
    catch {
        // Fall through to native system compress
    }
    const isZip = dest.toLowerCase().endsWith('.zip');
    const isTar = /\.(tar|tar\.gz|tgz)$/i.test(dest);
    const stat = statSync(source);
    // 2. Native zip on macOS / Linux
    if (isZip) {
        try {
            if (stat.isDirectory()) {
                execFileSync('zip', ['-q', '-r', dest, '.'], { cwd: source, stdio: 'pipe' });
            }
            else {
                execFileSync('zip', ['-q', dest, path.basename(source)], { cwd: path.dirname(source), stdio: 'pipe' });
            }
            return { success: true, output: `Compressed successfully to ${dest} (via zip)` };
        }
        catch {
            // Fall through
        }
    }
    // 3. Native tar on macOS / Linux
    if (isTar) {
        try {
            if (stat.isDirectory()) {
                execFileSync('tar', ['-czf', dest, '-C', source, '.'], { stdio: 'pipe' });
            }
            else {
                execFileSync('tar', ['-czf', dest, '-C', path.dirname(source), path.basename(source)], { stdio: 'pipe' });
            }
            return { success: true, output: `Compressed successfully to ${dest} (via tar)` };
        }
        catch {
            // Fall through
        }
    }
    // 4. Cross-platform Python fallback
    try {
        execFileSync('python3', [
            '-c',
            'import zipfile, os, sys\n' +
                'src, dst = sys.argv[1], sys.argv[2]\n' +
                'with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as z:\n' +
                '    if os.path.isdir(src):\n' +
                '        for root, dirs, files in os.walk(src):\n' +
                '            for file in files:\n' +
                '                full = os.path.join(root, file)\n' +
                '                rel = os.path.relpath(full, src)\n' +
                '                z.write(full, rel)\n' +
                '    else:\n' +
                '        z.write(src, os.path.basename(src))\n',
            source,
            dest
        ], { stdio: 'pipe' });
        return { success: true, output: `Compressed successfully to ${dest} (via python3 zipfile)` };
    }
    catch (pyErr) {
        return { success: false, error: `Compression failed: ${pyErr?.message || String(pyErr)}` };
    }
}
