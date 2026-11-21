import fs from 'node:fs/promises';
import { existsSync, lstatSync, realpathSync, statSync, createWriteStream } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveUserPath } from '../utils/paths.js';
import { loadCapabilityPackage } from '../provisioning/capabilityProvisioner.js';
function expandArchivePath(raw, baseRoot) {
    const trimmed = raw.trim();
    if (trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
        return resolveUserPath(trimmed);
    }
    if (path.isAbsolute(trimmed))
        return path.resolve(trimmed);
    return path.resolve(baseRoot ? resolveUserPath(baseRoot) : process.cwd(), trimmed);
}
function canonicalArchivePath(target) {
    const resolved = path.resolve(target);
    try {
        return realpathSync(resolved);
    }
    catch {
        let current = resolved;
        const missing = [];
        for (let i = 0; i < 64; i++) {
            const parent = path.dirname(current);
            if (parent === current)
                break;
            missing.unshift(path.basename(current));
            current = parent;
            try {
                return path.join(realpathSync(current), ...missing);
            }
            catch {
                continue;
            }
        }
        return resolved;
    }
}
function assertArchiveScope(target, context) {
    if (!context || context.grantAllAccess === true)
        return;
    const configured = Array.isArray(context.workspacePaths)
        ? context.workspacePaths.filter((p) => typeof p === 'string' && p.trim().length > 0).map(p => p.trim())
        : [];
    const roots = configured.length > 0
        ? configured
        : [context.parentLoop?.workspaceRoot, context.workspaceRoot]
            .filter((p) => typeof p === 'string' && p.trim().length > 0)
            .map(p => p.trim());
    if (roots.length === 0)
        return;
    const physical = canonicalArchivePath(target);
    for (const root of roots) {
        try {
            const realRoot = realpathSync(resolveUserPath(root));
            const rel = path.relative(realRoot, physical);
            if (rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)))
                return;
        }
        catch {
            continue;
        }
    }
    throw new Error(`Archive path resolves outside the selected workspace: ${target}`);
}
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
    async execute(args, context) {
        try {
            if (!args || typeof args !== 'object' || typeof args.action !== 'string' || typeof args.source !== 'string' || typeof args.destination !== 'string' || !args.source.trim() || !args.destination.trim()) {
                return { success: false, error: 'Missing required arguments: action, source, destination' };
            }
            const baseRoot = context?.parentLoop?.workspaceRoot?.trim()
                || context?.workspaceRoot?.trim()
                || context?.workspacePaths?.find((p) => typeof p === 'string' && p.trim().length > 0)?.trim();
            const isHomeOrAbs = (val) => {
                const trimmed = val.trim();
                return trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\') || path.isAbsolute(trimmed);
            };
            const source = (!baseRoot || isHomeOrAbs(args.source))
                ? resolveUserPath(args.source)
                : expandArchivePath(args.source, baseRoot);
            const dest = (!baseRoot || isHomeOrAbs(args.destination))
                ? resolveUserPath(args.destination)
                : expandArchivePath(args.destination, baseRoot);
            assertArchiveScope(source, context);
            assertArchiveScope(dest, context);
            if (!existsSync(source)) {
                return { success: false, error: `Archive source path not found: ${source}` };
            }
            if (existsSync(dest) && lstatSync(dest).isSymbolicLink()) {
                return { success: false, error: `Refusing to write through symbolic link destination: ${dest}` };
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
function isUnsafeArchiveMemberName(member) {
    const normalized = member.replace(/\\/g, '/').trim();
    if (!normalized)
        return true;
    if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized))
        return true;
    return normalized.split('/').some(seg => seg === '..');
}
function precheckNativeZipEntries(source) {
    const listing = execFileSync('unzip', ['-Z', '-s', source], {
        stdio: 'pipe',
        encoding: 'utf8',
        timeout: 15_000,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true
    });
    for (const line of listing.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('Archive:') || trimmed.startsWith('Zip file size:') || /^\d+\s+files?,/.test(trimmed))
            continue;
        if (/^l/.test(trimmed)) {
            throw new Error(`Refusing symlink entry inside zip archive: ${trimmed}`);
        }
        const parts = trimmed.split(/\s+/);
        const name = parts.slice(8).join(' ');
        if (name && isUnsafeArchiveMemberName(name)) {
            throw new Error(`Refusing unsafe zip archive path traversal entry: ${name}`);
        }
    }
}
function precheckNativeTarEntries(source) {
    const listing = execFileSync('tar', ['-tvf', source], {
        stdio: 'pipe',
        encoding: 'utf8',
        timeout: 15_000,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true
    });
    for (const line of listing.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed)
            continue;
        if (/^[lhbcp]/.test(trimmed) || trimmed.includes(' -> ')) {
            throw new Error(`Refusing symlink or special device entry inside tar archive: ${trimmed}`);
        }
    }
    const names = execFileSync('tar', ['-tf', source], {
        stdio: 'pipe',
        encoding: 'utf8',
        timeout: 15_000,
        maxBuffer: 10 * 1024 * 1024,
        windowsHide: true
    });
    for (const name of names.split('\n')) {
        if (name.trim() && isUnsafeArchiveMemberName(name)) {
            throw new Error(`Refusing unsafe tar archive path traversal entry: ${name}`);
        }
    }
}
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
    // 2. Native unzip on macOS / Linux (pre-checked against Zip-Slip and symlinks)
    if (isZip) {
        try {
            precheckNativeZipEntries(source);
            execFileSync('unzip', ['-q', '-o', source, '-d', dest], {
                stdio: 'pipe',
                timeout: 60_000,
                maxBuffer: 10 * 1024 * 1024,
                windowsHide: true
            });
            return { success: true, output: `Extracted successfully to ${dest} (via unzip)` };
        }
        catch (zipErr) {
            const msg = String(zipErr?.message || '');
            if (msg.startsWith('Refusing ')) {
                return { success: false, error: msg };
            }
            // Fall through to python3 or powershell
        }
    }
    // 3. Native tar on macOS / Linux (pre-checked against Tar-Slip and symlinks)
    if (isTar || !isZip) {
        try {
            precheckNativeTarEntries(source);
            execFileSync('tar', ['-xf', source, '-C', dest], {
                stdio: 'pipe',
                timeout: 60_000,
                maxBuffer: 10 * 1024 * 1024,
                windowsHide: true
            });
            return { success: true, output: `Extracted successfully to ${dest} (via tar)` };
        }
        catch (tarErr) {
            const msg = String(tarErr?.message || '');
            if (msg.startsWith('Refusing ')) {
                return { success: false, error: msg };
            }
            // Fall through
        }
    }
    // 4. Cross-platform Python standard library fallback (Zip-Slip & Tar-Slip safe)
    try {
        execFileSync('python3', [
            '-c',
            'import zipfile, tarfile, sys, os, stat\n' +
                'src, dst = sys.argv[1], os.path.realpath(sys.argv[2])\n' +
                'max_bytes = 256 * 1024 * 1024\n' +
                'def safe_target(name):\n' +
                '    if not name or name.startswith("/") or name.startswith("\\\\") or (len(name) > 1 and name[1] == ":"):\n' +
                '        raise ValueError(f"Unsafe archive entry path: {name}")\n' +
                '    out = os.path.realpath(os.path.join(dst, name))\n' +
                '    if out != dst and not out.startswith(dst + os.sep):\n' +
                '        raise ValueError(f"Archive path traversal blocked: {name}")\n' +
                '    return out\n' +
                'if zipfile.is_zipfile(src):\n' +
                '    with zipfile.ZipFile(src, "r") as z:\n' +
                '        total = 0\n' +
                '        for info in z.infolist():\n' +
                '            if stat.S_ISLNK(info.external_attr >> 16):\n' +
                '                raise ValueError(f"Refusing symlink archive entry: {info.filename}")\n' +
                '            total += info.file_size\n' +
                '            if total > max_bytes:\n' +
                '                raise ValueError("Archive exceeds 256 MB uncompressed safety limit")\n' +
                '            safe_target(info.filename)\n' +
                '        z.extractall(dst)\n' +
                'elif tarfile.is_tarfile(src):\n' +
                '    with tarfile.open(src, "r:*") as t:\n' +
                '        total = 0\n' +
                '        members = t.getmembers()\n' +
                '        for m in members:\n' +
                '            if m.issym() or m.islnk() or m.isdev() or m.isfifo():\n' +
                '                raise ValueError(f"Refusing unsafe tar entry: {m.name}")\n' +
                '            total += max(0, m.size)\n' +
                '            if total > max_bytes:\n' +
                '                raise ValueError("Archive exceeds 256 MB uncompressed safety limit")\n' +
                '            safe_target(m.name)\n' +
                '        t.extractall(dst, members=members)\n' +
                'else:\n' +
                '    raise ValueError("Unrecognized archive format")\n',
            source,
            dest
        ], { stdio: 'pipe', timeout: 60_000, maxBuffer: 10 * 1024 * 1024, windowsHide: true });
        return { success: true, output: `Extracted successfully to ${dest} (via python3)` };
    }
    catch (pyErr) {
        const pyMsg = String(pyErr?.stderr || pyErr?.message || '');
        if (/traversal|unsafe|symlink|256 MB/i.test(pyMsg)) {
            return { success: false, error: `Refused unsafe archive extraction: ${pyMsg.trim()}` };
        }
        // Fall through
    }
    // 5. Windows PowerShell fallback
    if (process.platform === 'win32') {
        try {
            const psScript = `Expand-Archive -LiteralPath '${source.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`;
            execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], {
                stdio: 'pipe',
                timeout: 60_000,
                maxBuffer: 10 * 1024 * 1024,
                windowsHide: true
            });
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
            return await new Promise((resolve) => {
                let settled = false;
                const settle = (res) => {
                    if (settled)
                        return;
                    settled = true;
                    resolve(res);
                };
                const output = createWriteStream(dest);
                const lowerDest = dest.toLowerCase();
                const isTarGz = lowerDest.endsWith('.tar.gz') || lowerDest.endsWith('.tgz');
                const format = lowerDest.endsWith('.tar') || isTarGz ? 'tar' : 'zip';
                const archiveStream = archiver(format, format === 'tar' ? { gzip: isTarGz } : { zlib: { level: 9 } });
                output.on('close', () => settle({ success: true, output: `Compressed ${archiveStream.pointer()} total bytes to ${dest}` }));
                output.on('error', (err) => settle({ success: false, error: err?.message || String(err) }));
                archiveStream.on('error', (err) => settle({ success: false, error: err?.message || String(err) }));
                archiveStream.pipe(output);
                try {
                    const stat = statSync(source);
                    if (stat.isDirectory()) {
                        archiveStream.directory(source, false);
                    }
                    else {
                        archiveStream.file(source, { name: path.basename(source) });
                    }
                    Promise.resolve(archiveStream.finalize()).catch((err) => {
                        settle({ success: false, error: err?.message || String(err) });
                    });
                }
                catch (err) {
                    output.destroy();
                    settle({ success: false, error: err?.message || String(err) });
                }
            });
        }
    }
    catch {
        // Fall through to native system compress
    }
    const isZip = dest.toLowerCase().endsWith('.zip');
    const isTar = /\.(tar|tar\.gz|tgz)$/i.test(dest);
    const isTarGz = /\.(tar\.gz|tgz)$/i.test(dest);
    const stat = statSync(source);
    const execOpts = { stdio: 'pipe', timeout: 60_000, maxBuffer: 10 * 1024 * 1024, windowsHide: true };
    // 2. Native zip on macOS / Linux
    if (isZip) {
        try {
            if (stat.isDirectory()) {
                execFileSync('zip', ['-q', '-r', dest, '.'], { cwd: source, ...execOpts });
            }
            else {
                execFileSync('zip', ['-q', dest, '--', path.basename(source)], { cwd: path.dirname(source), ...execOpts });
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
            const tarFlag = isTarGz ? '-czf' : '-cf';
            if (stat.isDirectory()) {
                execFileSync('tar', [tarFlag, dest, '-C', source, '.'], execOpts);
            }
            else {
                execFileSync('tar', [tarFlag, dest, '-C', path.dirname(source), '--', path.basename(source)], execOpts);
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
        ], execOpts);
        return { success: true, output: `Compressed successfully to ${dest} (via python3 zipfile)` };
    }
    catch (pyErr) {
        return { success: false, error: `Compression failed: ${pyErr?.message || String(pyErr)}` };
    }
}
