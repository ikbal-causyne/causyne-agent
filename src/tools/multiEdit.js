import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteFileSync } from '../infra/atomicWriter.js';
import { collectActivePostEditDiagnostics, formatDiagnosticsCompact } from '../lsp/lspClient.js';
import { applyDeterministicEdit } from './fsEdit.js';
function expandHome(value) {
    const trimmed = value.trim();
    if (trimmed === '~')
        return os.homedir();
    if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
        return path.join(os.homedir(), trimmed.slice(2));
    }
    return trimmed;
}
function insideRoot(root, target) {
    const rel = path.relative(root, target);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}
async function assertWithinScope(target, context) {
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
    const realTarget = await fs.realpath(target);
    for (const root of roots) {
        try {
            const realRoot = await fs.realpath(path.resolve(expandHome(root)));
            if (insideRoot(realRoot, realTarget))
                return;
        }
        catch {
            continue;
        }
    }
    throw new Error(`Target resolves outside the selected workspace: ${target}`);
}
export const multiEdit = {
    schema: {
        name: 'MultiEdit',
        description: 'Make multiple edits to a single file atomically. Replaces old_string with new_string using exact, EOL-preserving, and whitespace/indent-preserving unique matching. Rejects ambiguous matches unless replace_all is true.',
        parameters: {
            type: 'object',
            properties: {
                file_path: { type: 'string' },
                replace_all: { type: 'boolean', description: 'When true, replace all matching occurrences instead of requiring a unique match.' },
                edits: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            old_string: { type: 'string' },
                            new_string: { type: 'string' },
                            replace_all: { type: 'boolean' }
                        },
                        required: ['old_string', 'new_string']
                    },
                    minItems: 1
                }
            },
            required: ['file_path', 'edits']
        }
    },
    async execute(args, context) {
        try {
            if (!args || typeof args !== 'object') {
                return { success: false, error: 'MultiEdit requires an object with file_path and edits array.' };
            }
            if (typeof args.file_path !== 'string' || !args.file_path.trim()) {
                return { success: false, error: 'MultiEdit requires a non-empty string file_path.' };
            }
            if (!Array.isArray(args.edits) || args.edits.length === 0) {
                return { success: false, error: 'MultiEdit requires a non-empty edits array.' };
            }
            const expandedPath = expandHome(args.file_path);
            const baseRoot = context?.parentLoop?.workspaceRoot?.trim()
                || context?.workspaceRoot?.trim()
                || context?.workspacePaths?.find((p) => typeof p === 'string' && p.trim().length > 0)?.trim();
            const target = path.isAbsolute(expandedPath)
                ? path.resolve(expandedPath)
                : path.resolve(baseRoot ? path.resolve(expandHome(baseRoot)) : process.cwd(), expandedPath);
            const stat = await fs.lstat(target);
            if (stat.isSymbolicLink()) {
                return { success: false, error: `Refusing to edit symbolic link ${target}; edit a regular file in the selected workspace.` };
            }
            if (!stat.isFile()) {
                return { success: false, error: `Target is not a regular file: ${target}` };
            }
            await assertWithinScope(target, context);
            const originalMode = stat.mode & 0o777;
            const originalContent = await fs.readFile(target, 'utf8');
            let workingContent = originalContent;
            let replacements = 0;
            for (let i = 0; i < args.edits.length; i++) {
                const edit = args.edits[i];
                if (!edit || typeof edit.old_string !== 'string' || edit.old_string.length === 0 || typeof edit.new_string !== 'string') {
                    return {
                        success: false,
                        error: `ATOMIC ROLLBACK: Edit index ${i} is missing valid non-empty old_string or new_string. Rollback complete.`
                    };
                }
                const replaceAll = edit.replace_all === true || edit.replaceAll === true || args.replace_all === true || args.replaceAll === true;
                const applied = applyDeterministicEdit(workingContent, edit.old_string, edit.new_string, replaceAll, i);
                if (!applied.ok) {
                    return { success: false, error: applied.error };
                }
                workingContent = applied.nextContent;
                replacements += applied.count;
            }
            // Commit the transaction atomically, preserving original file permissions
            atomicWriteFileSync(target, workingContent, { encoding: 'utf8', mode: originalMode });
            const wsRoot = baseRoot ? path.resolve(expandHome(baseRoot)) : path.dirname(target);
            const diags = await collectActivePostEditDiagnostics(target, wsRoot, workingContent);
            const diagNote = diags.length > 0 ? `\n\n[LSP Diagnostics]\n${formatDiagnosticsCompact(diags, wsRoot)}` : '';
            return { success: true, output: `Transaction Success: ${replacements} atomic edits applied to ${args.file_path}${diagNote}` };
        }
        catch (e) {
            return { success: false, error: e instanceof Error ? e.message : String(e) };
        }
    }
};
