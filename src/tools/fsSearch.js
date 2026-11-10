import fs from 'node:fs/promises';
import path from 'node:path';
import { MAX_FILE_BYTES, checkSearchScope, compileSafeSearchRegex, createTraversalGuard, isSafeSymlinkTarget, loadGitIgnoreNames, looksBinaryFile, resolveSearchRoot, shouldExcludeChild } from './walkerSafety.js';
const DEFAULT_MAX_RESULTS = 100;
async function* walk(dir, rootReal, ignorePatterns, seen, guard, depth, context) {
    if (!guard.enterDir(depth))
        return;
    let real;
    try {
        real = await fs.realpath(dir);
    }
    catch {
        return;
    }
    if (!isSafeSymlinkTarget(real, rootReal, context))
        return;
    if (seen.has(real))
        return;
    seen.add(real);
    let entries;
    try {
        entries = await fs.readdir(dir, { withFileTypes: true });
    }
    catch {
        return;
    }
    for (const entry of entries) {
        if (guard.checkStopped())
            return;
        if (shouldExcludeChild(real, entry.name, ignorePatterns))
            continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            yield* walk(full, rootReal, ignorePatterns, seen, guard, depth + 1, context);
        }
        else if (entry.isFile()) {
            yield full;
        }
        else if (entry.isSymbolicLink()) {
            try {
                const targetReal = await fs.realpath(full);
                if (!isSafeSymlinkTarget(targetReal, rootReal, context))
                    continue;
                const stat = await fs.stat(targetReal);
                if (stat.isDirectory()) {
                    yield* walk(targetReal, rootReal, ignorePatterns, seen, guard, depth + 1, context);
                }
                else if (stat.isFile()) {
                    yield full;
                }
            }
            catch {
                // Ignore broken or inaccessible symlinks.
            }
        }
    }
}
export const fsSearch = {
    schema: {
        name: 'fs.search',
        description: 'Search for text across files in a directory tree. Enforces bounded depth/time, workspace & symlink safety, and skips build/system/binary files.',
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Text or regular expression to find.' },
                path: { type: 'string', description: 'Directory or file to search in. Defaults to workspace root.' },
                isRegex: { type: 'boolean', description: 'Treat the query as a regular expression.' },
                maxResults: {
                    type: 'integer',
                    description: `Stop after this many matching lines. Defaults to ${DEFAULT_MAX_RESULTS}.`
                }
            },
            required: ['query']
        }
    },
    async execute(args, context) {
        try {
            if (!args || typeof args.query !== 'string' || args.query.length === 0) {
                return { success: false, error: 'Missing required "query" argument.' };
            }
            const maxResults = typeof args.maxResults === 'number' && Number.isInteger(args.maxResults) && args.maxResults > 0
                ? Math.min(args.maxResults, 1000)
                : DEFAULT_MAX_RESULTS;
            const compiled = compileSafeSearchRegex(args.query, {
                isRegex: args.isRegex === true,
                caseInsensitive: args.isRegex !== true
            });
            if (!compiled.regex) {
                return { success: false, error: compiled.error || 'Invalid regular expression.' };
            }
            const regex = compiled.regex;
            const searchPath = resolveSearchRoot(args.path, context);
            const scope = checkSearchScope(searchPath, context);
            if (!scope.allowed || !scope.realPath) {
                return { success: false, error: scope.error || `Search path not allowed: ${searchPath}` };
            }
            const rootReal = scope.realPath;
            let rootStat;
            try {
                rootStat = await fs.stat(rootReal);
            }
            catch {
                return { success: false, error: `Search path does not exist: ${searchPath}` };
            }
            const maxDepth = typeof args.maxDepth === 'number' && Number.isInteger(args.maxDepth) && args.maxDepth > 0
                ? Math.min(args.maxDepth, 24)
                : undefined;
            const guard = createTraversalGuard({ maxDepth, signal: context?.signal });
            const results = [];
            let filesScanned = 0;
            let filesSkipped = 0;
            let truncated = false;
            const scanOneFile = async (file) => {
                if (!guard.countFile())
                    return;
                let stat;
                try {
                    stat = await fs.stat(file);
                }
                catch {
                    return;
                }
                if (stat.size > MAX_FILE_BYTES) {
                    filesSkipped++;
                    return;
                }
                if (await looksBinaryFile(file)) {
                    filesSkipped++;
                    return;
                }
                let content;
                try {
                    content = await fs.readFile(file, 'utf8');
                }
                catch {
                    return;
                }
                filesScanned++;
                const lines = content.split('\n');
                for (let i = 0; i < lines.length; i++) {
                    if (guard.checkStopped())
                        break;
                    const line = lines[i];
                    if (!regex.test(line))
                        continue;
                    results.push(`${file}:${i + 1}:${line.trim().slice(0, 300)}`);
                    if (results.length >= maxResults) {
                        truncated = true;
                        break;
                    }
                }
            };
            if (rootStat.isFile()) {
                await scanOneFile(searchPath);
            }
            else {
                const ignorePatterns = await loadGitIgnoreNames(rootReal);
                for await (const file of walk(rootReal, rootReal, ignorePatterns, new Set(), guard, 0, context)) {
                    if (results.length >= maxResults) {
                        truncated = true;
                        break;
                    }
                    if (guard.checkStopped())
                        break;
                    await scanOneFile(file);
                    if (results.length >= maxResults) {
                        truncated = true;
                        break;
                    }
                }
            }
            if (guard.stopReason === 'aborted') {
                return { success: false, aborted: true, error: 'Search aborted.' };
            }
            const budgetNotice = guard.stopReason ? ` (${guard.stopNotice()})` : '';
            if (results.length === 0) {
                return {
                    success: true,
                    output: `No matches found. Scanned ${filesScanned} files under ${searchPath}` +
                        (filesSkipped > 0 ? `; skipped ${filesSkipped} binary or oversized files` : '') +
                        `${budgetNotice}.`
                };
            }
            const footerParts = [];
            if (truncated) {
                footerParts.push(`stopped at ${maxResults} matches — narrow the query or raise maxResults`);
            }
            if (guard.stopReason) {
                footerParts.push(guard.stopNotice());
            }
            const footer = footerParts.length > 0 ? `\n\n[${footerParts.join('; ')}]` : '';
            return {
                success: true,
                output: results.join('\n') + footer
            };
        }
        catch (error) {
            return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
    }
};
