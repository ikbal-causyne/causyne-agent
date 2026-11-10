import fs from 'node:fs/promises';
import path from 'node:path';
import { checkSearchScope, createTraversalGuard, isSafeSymlinkTarget, resolveSearchRoot, shouldExcludeChild } from './walkerSafety.js';
const DEFAULT_LIST_DEPTH = 2;
const MAX_LIST_DEPTH = 8;
const MAX_TREE_ENTRIES = 500;
async function generateTree(dirPath, rootReal, currentDepth, maxDepth, seen, guard, state, prefix, context) {
    if (currentDepth > maxDepth || state.truncated || guard.checkStopped())
        return '';
    let dirReal;
    try {
        dirReal = await fs.realpath(dirPath);
    }
    catch {
        return `${prefix}└── [Access Denied]\n`;
    }
    if (!isSafeSymlinkTarget(dirReal, rootReal, context))
        return '';
    if (seen.has(dirReal))
        return `${prefix}└── [Symlink Cycle Skipped]\n`;
    if (!guard.enterDir(currentDepth)) {
        state.truncated = true;
        return '';
    }
    seen.add(dirReal);
    let rawItems;
    try {
        rawItems = await fs.readdir(dirPath, { withFileTypes: true });
    }
    catch {
        return `${prefix}└── [Access Denied]\n`;
    }
    const items = rawItems.filter((item) => !shouldExcludeChild(dirReal, item.name));
    items.sort((a, b) => {
        const aDir = a.isDirectory();
        const bDir = b.isDirectory();
        if (aDir === bDir)
            return a.name.localeCompare(b.name);
        return aDir ? -1 : 1;
    });
    let treeStr = '';
    for (let i = 0; i < items.length; i++) {
        if (guard.checkStopped() || state.entryCount >= MAX_TREE_ENTRIES) {
            state.truncated = true;
            break;
        }
        const item = items[i];
        const isLast = i === items.length - 1;
        const marker = isLast ? '└── ' : '├── ';
        const newPrefix = prefix + (isLast ? '    ' : '│   ');
        const fullPath = path.join(dirPath, item.name);
        let isDir = item.isDirectory();
        let metadata = '';
        if (item.isSymbolicLink()) {
            try {
                const targetReal = await fs.realpath(fullPath);
                if (!isSafeSymlinkTarget(targetReal, rootReal, context)) {
                    treeStr += `${prefix}${marker}${item.name} [symlink outside scope skipped]\n`;
                    state.entryCount++;
                    continue;
                }
                const stat = await fs.stat(targetReal);
                isDir = stat.isDirectory();
                if (!isDir) {
                    metadata = ` (${Math.round(stat.size / 1024)}KB)`;
                }
            }
            catch {
                treeStr += `${prefix}${marker}${item.name} [broken symlink]\n`;
                state.entryCount++;
                continue;
            }
        }
        else if (!isDir) {
            try {
                const stat = await fs.stat(fullPath);
                metadata = ` (${Math.round(stat.size / 1024)}KB)`;
            }
            catch {
                // Ignore stat error on transient files.
            }
        }
        treeStr += `${prefix}${marker}${item.name}${isDir ? '/' : ''}${metadata}\n`;
        state.entryCount++;
        if (isDir && currentDepth < maxDepth) {
            treeStr += await generateTree(fullPath, rootReal, currentDepth + 1, maxDepth, seen, guard, state, newPrefix, context);
        }
    }
    return treeStr;
}
export const fsList = {
    schema: {
        name: 'fs.list',
        description: 'List directory contents as an interactive Tree-Map. Enforces depth bounds, entry caps, and workspace/symlink safety.',
        parameters: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Directory to list. Defaults to workspace root.' },
                depth: {
                    type: 'number',
                    description: `Recursion depth (default ${DEFAULT_LIST_DEPTH}, max ${MAX_LIST_DEPTH})`
                }
            },
            required: ['path']
        }
    },
    async execute(args = {}, context) {
        try {
            const target = resolveSearchRoot(args?.path, context);
            const scope = checkSearchScope(target, context);
            if (!scope.allowed || !scope.realPath) {
                return { success: false, error: scope.error || `Directory path not allowed: ${target}` };
            }
            let stat;
            try {
                stat = await fs.stat(scope.realPath);
            }
            catch {
                return { success: false, error: `Directory does not exist: ${target}` };
            }
            if (!stat.isDirectory()) {
                return { success: false, error: `Path is not a directory: ${target}` };
            }
            const rawDepth = typeof args?.depth === 'number' && Number.isFinite(args.depth)
                ? Math.floor(args.depth)
                : DEFAULT_LIST_DEPTH;
            const maxDepth = Math.max(1, Math.min(rawDepth, MAX_LIST_DEPTH));
            const guard = createTraversalGuard({
                timeoutMs: 10_000,
                maxDirs: 2_000,
                maxDepth,
                signal: context?.signal
            });
            const state = { entryCount: 0, truncated: false };
            const tree = await generateTree(scope.realPath, scope.realPath, 1, maxDepth, new Set(), guard, state, '', context);
            if (guard.stopReason === 'aborted') {
                return { success: false, aborted: true, error: 'Directory listing aborted.' };
            }
            const notices = [];
            if (state.entryCount >= MAX_TREE_ENTRIES) {
                notices.push(`truncated at ${MAX_TREE_ENTRIES} entries`);
            }
            if (guard.stopReason) {
                notices.push(guard.stopNotice());
            }
            const footer = notices.length > 0 ? `\n[${notices.join('; ')}]` : '';
            const header = `${target}\n`;
            return {
                success: true,
                output: header + (tree || '  (Empty or access denied)') + footer
            };
        }
        catch (error) {
            return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
    }
};
