import { execFile } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { DEFAULT_TIMEOUT_MS, MAX_FILE_BYTES, buildHomeGlobExcludes, buildTopLevelHomeExcludes, checkSearchScope, compileSafeSearchRegex, createTraversalGuard, isSafeSymlinkTarget, looksBinaryFile, resolveSearchRoot, shouldExcludeChild, validateRegexSafety } from './walkerSafety.js';
const execFileAsync = promisify(execFile);
const MAX_MATCHES = 100;
const RG_MAX_PER_FILE = 50;
function getRipgrepBinary() {
    const isWin = process.platform === 'win32';
    const fixedCandidates = isWin
        ? ['C:\\Program Files\\ripgrep\\rg.exe']
        : ['/opt/homebrew/bin/rg', '/usr/local/bin/rg', '/usr/bin/rg'];
    for (const candidate of fixedCandidates) {
        try {
            if (fsSync.existsSync(candidate))
                return candidate;
        }
        catch {
            // Ignore permission errors probing candidate paths.
        }
    }
    const pathEnv = process.env.PATH || '';
    const exeName = isWin ? 'rg.exe' : 'rg';
    for (const dir of pathEnv.split(path.delimiter)) {
        if (!dir)
            continue;
        const candidate = path.join(dir, exeName);
        try {
            if (fsSync.existsSync(candidate))
                return candidate;
        }
        catch {
            // Ignore unreadable PATH directory entries.
        }
    }
    return null;
}
function globToSuffix(filePattern) {
    if (!filePattern || filePattern === '*')
        return null;
    if (filePattern.startsWith('*.') && !filePattern.slice(2).includes('*')) {
        return filePattern.slice(1).toLowerCase();
    }
    return null;
}
function escapeLiteralRegex(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function parseRgLine(line) {
    let idx = line.indexOf(':');
    // Skip Windows drive letter prefix like C:\foo:12:bar
    if (idx === 1 && /^[a-zA-Z]$/.test(line[0] ?? '') && (line[2] === '\\' || line[2] === '/')) {
        idx = line.indexOf(':', 2);
    }
    while (idx > 0) {
        const nextColon = line.indexOf(':', idx + 1);
        if (nextColon === -1)
            return null;
        const lineNumStr = line.slice(idx + 1, nextColon);
        if (lineNumStr.length > 0 && /^\d+$/.test(lineNumStr)) {
            return {
                File: line.slice(0, idx),
                LineNumber: Number.parseInt(lineNumStr, 10) || 0,
                LineContent: line.slice(nextColon + 1).trim().slice(0, 300)
            };
        }
        idx = nextColon;
    }
    return null;
}
function isInvalidGlob(filePattern) {
    return (filePattern.startsWith('-') ||
        /[\x00-\x1f\r\n]/.test(filePattern));
}
export const codeSearcher = {
    schema: {
        name: 'code.search_ripgrep',
        description: 'Fast regex, literal string, and symbol search across codebases using ripgrep with bounded async Node fallback.',
        parameters: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'The exact string, symbol, or regular expression pattern to look for across files.'
                },
                searchPath: {
                    type: 'string',
                    description: 'Directory or file path to search. Defaults to workspace root.'
                },
                isRegex: {
                    type: 'boolean',
                    description: 'If true, treats query as a regular expression pattern. If false, treats as literal string.'
                },
                caseInsensitive: {
                    type: 'boolean',
                    description: 'If true, performs case-insensitive search (default true).'
                },
                filePattern: {
                    type: 'string',
                    description: 'Optional glob filter (e.g. "*.js", "*.py", "*.kt", "*.ts") to restrict file extensions.'
                },
                astMode: {
                    type: 'boolean',
                    description: 'If true, filters results specifically for symbol definitions (classes, functions, interfaces, structs, defs).'
                }
            },
            required: ['query']
        }
    },
    async execute(args, context) {
        try {
            if (!args || typeof args.query !== 'string' || args.query.length === 0) {
                return { success: false, error: 'Query parameter is required.' };
            }
            const query = args.query;
            const isRegex = args.isRegex === true;
            const caseInsensitive = args.caseInsensitive !== false;
            const filePattern = typeof args.filePattern === 'string' ? args.filePattern.trim() : '*';
            const astMode = args.astMode === true;
            if (filePattern && filePattern !== '*' && isInvalidGlob(filePattern)) {
                return { success: false, error: `Invalid filePattern glob: ${filePattern}` };
            }
            if (isRegex) {
                const unsafeReason = validateRegexSafety(query);
                if (unsafeReason) {
                    return { success: false, error: unsafeReason };
                }
            }
            const targetDir = resolveSearchRoot(args.searchPath, context);
            const scope = checkSearchScope(targetDir, context);
            if (!scope.allowed || !scope.realPath) {
                return { success: false, error: scope.error || `Search path not allowed: ${targetDir}` };
            }
            const realTargetDir = scope.realPath;
            let targetStat;
            try {
                targetStat = await fs.stat(realTargetDir);
            }
            catch {
                return { success: false, error: `Search path does not exist: ${targetDir}` };
            }
            const matches = [];
            const rgBin = getRipgrepBinary();
            let engineLabel = rgBin ? `Ripgrep Binary (${rgBin})` : 'Node Async Stream Engine';
            let useNodeFallback = !rgBin;
            let stoppedNotice = '';
            if (rgBin) {
                const rgArgs = [
                    '-n',
                    '--no-heading',
                    '--with-filename',
                    `--max-count=${RG_MAX_PER_FILE}`,
                    `--max-filesize=${MAX_FILE_BYTES}`
                ];
                if (caseInsensitive)
                    rgArgs.push('-i');
                if (!isRegex && !astMode)
                    rgArgs.push('-F');
                if (filePattern && filePattern !== '*')
                    rgArgs.push('-g', filePattern);
                for (const glob of buildHomeGlobExcludes()) {
                    rgArgs.push('-g', glob);
                }
                for (const glob of buildTopLevelHomeExcludes(realTargetDir)) {
                    rgArgs.push('-g', glob);
                }
                const effectiveQuery = astMode && !isRegex
                    ? `(class|function|def|interface|struct|const|let|var|type|func|module)\\s+[^\\s(]*${escapeLiteralRegex(query)}`
                    : query;
                rgArgs.push('-e', effectiveQuery, '--', realTargetDir);
                try {
                    const { stdout } = await execFileAsync(rgBin, rgArgs, {
                        maxBuffer: 10 * 1024 * 1024,
                        timeout: DEFAULT_TIMEOUT_MS,
                        signal: context?.signal
                    });
                    for (const line of stdout.split('\n')) {
                        if (!line)
                            continue;
                        if (matches.length >= MAX_MATCHES)
                            break;
                        const parsed = parseRgLine(line);
                        if (parsed)
                            matches.push(parsed);
                    }
                }
                catch (rgErr) {
                    if (context?.signal?.aborted) {
                        return { success: false, aborted: true, error: 'Code search aborted.' };
                    }
                    const errObj = rgErr;
                    if (typeof errObj.stdout === 'string' && errObj.stdout.length > 0) {
                        for (const line of errObj.stdout.split('\n')) {
                            if (!line)
                                continue;
                            if (matches.length >= MAX_MATCHES)
                                break;
                            const parsed = parseRgLine(line);
                            if (parsed)
                                matches.push(parsed);
                        }
                    }
                    if (errObj.killed) {
                        stoppedNotice = `stopped after ${DEFAULT_TIMEOUT_MS}ms budget`;
                    }
                    else if (errObj.code === 1) {
                        // Exit code 1 means zero matches found.
                    }
                    else if (errObj.code === 2) {
                        const stderr = String(errObj.stderr || '').trim();
                        if (/regex parse error|error parsing regex/i.test(stderr)) {
                            return { success: false, error: `Invalid regex pattern: ${stderr}` };
                        }
                        useNodeFallback = true;
                    }
                    else if (errObj.code === 'ENOENT' || errObj.code === 'EACCES') {
                        useNodeFallback = true;
                    }
                    else if (matches.length === 0) {
                        useNodeFallback = true;
                    }
                }
            }
            if (useNodeFallback && matches.length === 0) {
                engineLabel = 'Node Async Stream Engine';
                let regex;
                if (astMode && !isRegex) {
                    const astPat = `(class|function|def|interface|struct|const|let|var|type|func|module)\\s+[^\\s(]*${escapeLiteralRegex(query)}`;
                    regex = new RegExp(astPat, caseInsensitive ? 'i' : '');
                }
                else {
                    const compiled = compileSafeSearchRegex(query, { isRegex, caseInsensitive });
                    if (!compiled.regex) {
                        return { success: false, error: compiled.error || 'Invalid regex pattern.' };
                    }
                    regex = compiled.regex;
                }
                const extFilter = globToSuffix(filePattern);
                const guard = createTraversalGuard({ signal: context?.signal });
                const seen = new Set();
                const scanFile = async (filePath) => {
                    if (matches.length >= MAX_MATCHES || guard.checkStopped())
                        return;
                    if (extFilter && !filePath.toLowerCase().endsWith(extFilter))
                        return;
                    if (!guard.countFile())
                        return;
                    let fileStat;
                    try {
                        fileStat = await fs.stat(filePath);
                    }
                    catch {
                        return;
                    }
                    if (fileStat.size > MAX_FILE_BYTES)
                        return;
                    if (await looksBinaryFile(filePath))
                        return;
                    let content;
                    try {
                        content = await fs.readFile(filePath, 'utf8');
                    }
                    catch {
                        return;
                    }
                    const lines = content.split('\n');
                    for (let i = 0; i < lines.length; i++) {
                        if (matches.length >= MAX_MATCHES || guard.checkStopped())
                            break;
                        const line = lines[i];
                        if (regex.test(line)) {
                            matches.push({
                                File: filePath,
                                LineNumber: i + 1,
                                LineContent: line.trim().slice(0, 300)
                            });
                        }
                    }
                };
                if (targetStat.isFile()) {
                    await scanFile(realTargetDir);
                }
                else {
                    const queue = [
                        { dir: realTargetDir, real: realTargetDir, depth: 0 }
                    ];
                    while (queue.length > 0 && matches.length < MAX_MATCHES) {
                        if (guard.checkStopped())
                            break;
                        const current = queue.shift();
                        if (seen.has(current.real))
                            continue;
                        if (!guard.enterDir(current.depth))
                            continue;
                        seen.add(current.real);
                        let dirents;
                        try {
                            dirents = await fs.readdir(current.dir, { withFileTypes: true });
                        }
                        catch {
                            continue;
                        }
                        for (const dirent of dirents) {
                            if (matches.length >= MAX_MATCHES || guard.checkStopped())
                                break;
                            if (shouldExcludeChild(current.real, dirent.name))
                                continue;
                            const full = path.join(current.dir, dirent.name);
                            if (dirent.isDirectory()) {
                                try {
                                    const childReal = await fs.realpath(full);
                                    if (isSafeSymlinkTarget(childReal, realTargetDir, context) && !seen.has(childReal)) {
                                        queue.push({ dir: full, real: childReal, depth: current.depth + 1 });
                                    }
                                }
                                catch {
                                    // Ignore unreadable subdirectories.
                                }
                            }
                            else if (dirent.isFile()) {
                                await scanFile(full);
                            }
                            else if (dirent.isSymbolicLink()) {
                                try {
                                    const linkReal = await fs.realpath(full);
                                    if (!isSafeSymlinkTarget(linkReal, realTargetDir, context))
                                        continue;
                                    const linkStat = await fs.stat(linkReal);
                                    if (linkStat.isDirectory()) {
                                        if (!seen.has(linkReal)) {
                                            queue.push({ dir: linkReal, real: linkReal, depth: current.depth + 1 });
                                        }
                                    }
                                    else if (linkStat.isFile()) {
                                        await scanFile(full);
                                    }
                                }
                                catch {
                                    // Ignore broken symlinks.
                                }
                            }
                        }
                    }
                }
                if (guard.stopReason === 'aborted') {
                    return { success: false, aborted: true, error: 'Code search aborted.' };
                }
                if (guard.stopReason) {
                    stoppedNotice = guard.stopNotice();
                }
            }
            return {
                success: true,
                output: JSON.stringify({
                    engine: engineLabel,
                    query,
                    total_matches: matches.length,
                    ...(stoppedNotice ? { stopped_reason: stoppedNotice } : {}),
                    matches: matches.length > 0 ? matches : 'No matches found in target codebase.'
                }, null, 2)
            };
        }
        catch (error) {
            return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
    }
};
