/**
 * Causyne Agent — Transactional Multi-File Patch Engine (`apply_patch`)
 *
 * Applies Codex-style multi-file V4A patches (`*** Begin Patch` ... `*** End Patch`)
 * atomically across multiple files in a single tool call:
 *   - `*** Add File: <path>`
 *   - `*** Update File: <path>` (with optional `*** Move to: <newPath>`)
 *   - `*** Delete File: <path>`
 *
 * Security & correctness invariants:
 *   - Pre-validates EVERY path, scope, symlink check, credential denial, and hunk
 *     in memory BEFORE writing a single byte to disk.
 *   - Atomic per-file write + best-effort rollback if any write step fails.
 *   - Whole-file deletions (`*** Delete File:`) are recognized by `approvalPolicy.ts`
 *     so they cannot bypass explicit deletion confirmation.
 *   - Collects active post-edit LSP diagnostics across all modified/created files.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFileSync } from '../infra/atomicWriter.js';
import { isCredentialPath } from '../sandbox.js';
import { collectActivePostEditDiagnostics, formatDiagnosticsCompact } from '../lsp/lspClient.js';
import { assertSafeWorkspaceOutput, resolveScopedPath, resolveToolWorkspaceRoots, sanitizeToolError, sanitizeToolText } from './toolPathSafety.js';
const MAX_PATCH_CHARS = 1024 * 1024;
const MAX_PATCH_OPERATIONS = 64;
const MAX_SOURCE_FILE_BYTES = 4 * 1024 * 1024;
/**
 * Lightweight linear scanner extracting every target path and deletion flag
 * from a V4A patch string for Sandbox, EnterprisePolicy, and Checkpoint guards.
 */
export function extractPatchTargetPaths(rawPatch) {
    if (typeof rawPatch !== 'string' || !rawPatch) {
        return { paths: [], hasDelete: false };
    }
    const seen = new Set();
    const paths = [];
    let hasDelete = false;
    const bounded = rawPatch.length > MAX_PATCH_CHARS ? rawPatch.slice(0, MAX_PATCH_CHARS) : rawPatch;
    const lines = bounded.split(/\r?\n/);
    for (const line of lines) {
        if (paths.length >= MAX_PATCH_OPERATIONS * 2)
            break;
        let target = null;
        if (line.startsWith('*** Add File:')) {
            target = line.slice('*** Add File:'.length).trim();
        }
        else if (line.startsWith('*** Update File:')) {
            target = line.slice('*** Update File:'.length).trim();
        }
        else if (line.startsWith('*** Delete File:')) {
            hasDelete = true;
            target = line.slice('*** Delete File:'.length).trim();
        }
        else if (line.startsWith('*** Move to:')) {
            target = line.slice('*** Move to:'.length).trim();
        }
        if (target && !target.includes('\0') && !seen.has(target)) {
            seen.add(target);
            paths.push(target);
        }
    }
    return { paths, hasDelete };
}
export function parsePatchText(rawPatch) {
    if (typeof rawPatch !== 'string' || !rawPatch.trim()) {
        throw new Error('Patch text must be a non-empty string.');
    }
    if (rawPatch.length > MAX_PATCH_CHARS) {
        throw new Error(`Patch text exceeds maximum allowed size (${MAX_PATCH_CHARS} characters).`);
    }
    if (rawPatch.includes('\0')) {
        throw new Error('Patch text cannot contain NUL bytes.');
    }
    const lines = rawPatch.replace(/\r\n/g, '\n').split('\n');
    let i = 0;
    while (i < lines.length && lines[i].trim() === '')
        i++;
    if (lines[i]?.trim() === '*** Begin Patch') {
        i++;
    }
    const operations = [];
    while (i < lines.length) {
        const line = lines[i];
        const trimmed = line.trim();
        if (trimmed === '*** End Patch')
            break;
        if (trimmed === '') {
            i++;
            continue;
        }
        if (operations.length >= MAX_PATCH_OPERATIONS) {
            throw new Error(`Patch exceeds maximum operation limit (${MAX_PATCH_OPERATIONS} files).`);
        }
        if (line.startsWith('*** Add File:')) {
            const target = line.slice('*** Add File:'.length).trim();
            if (!target)
                throw new Error('*** Add File: requires a target path.');
            i++;
            const bodyLines = [];
            while (i < lines.length) {
                const cur = lines[i];
                if (cur.startsWith('*** '))
                    break;
                if (cur.startsWith('+')) {
                    bodyLines.push(cur.slice(1));
                }
                else if (cur === '') {
                    // Trailing blank line before next header
                    if (i + 1 < lines.length && lines[i + 1].startsWith('*** ')) {
                        i++;
                        break;
                    }
                    bodyLines.push('');
                }
                else {
                    throw new Error(`Add File "${target}" lines must begin with "+" (got "${cur.slice(0, 40)}").`);
                }
                i++;
            }
            operations.push({
                type: 'add',
                path: target,
                content: bodyLines.join('\n') + (bodyLines.length > 0 ? '\n' : '')
            });
            continue;
        }
        if (line.startsWith('*** Delete File:')) {
            const target = line.slice('*** Delete File:'.length).trim();
            if (!target)
                throw new Error('*** Delete File: requires a target path.');
            operations.push({ type: 'delete', path: target });
            i++;
            continue;
        }
        if (line.startsWith('*** Update File:')) {
            const target = line.slice('*** Update File:'.length).trim();
            if (!target)
                throw new Error('*** Update File: requires a target path.');
            i++;
            let moveTo;
            if (i < lines.length && lines[i].startsWith('*** Move to:')) {
                moveTo = lines[i].slice('*** Move to:'.length).trim();
                if (!moveTo)
                    throw new Error(`*** Move to: for "${target}" requires a destination path.`);
                i++;
            }
            const hunks = [];
            let currentHunk = null;
            while (i < lines.length) {
                const cur = lines[i];
                if (cur.startsWith('*** ')) {
                    if (cur.trim() === '*** End of File') {
                        i++;
                        continue;
                    }
                    break;
                }
                if (cur.startsWith('@@')) {
                    currentHunk = {
                        contextHeader: cur.slice(2).trim(),
                        lines: []
                    };
                    hunks.push(currentHunk);
                    i++;
                    continue;
                }
                if (cur.startsWith(' ') || cur.startsWith('-') || cur.startsWith('+')) {
                    if (!currentHunk) {
                        currentHunk = { contextHeader: '', lines: [] };
                        hunks.push(currentHunk);
                    }
                    currentHunk.lines.push({
                        kind: cur[0],
                        text: cur.slice(1)
                    });
                    i++;
                    continue;
                }
                if (cur === '' && i + 1 < lines.length && lines[i + 1].startsWith('*** ')) {
                    i++;
                    break;
                }
                if (currentHunk) {
                    currentHunk.lines.push({ kind: ' ', text: cur });
                    i++;
                    continue;
                }
                throw new Error(`Unexpected line in Update File "${target}": "${cur.slice(0, 60)}"`);
            }
            if (hunks.length === 0 && !moveTo) {
                throw new Error(`Update File "${target}" contains no hunks and no Move to target.`);
            }
            operations.push({ type: 'update', path: target, moveTo, hunks });
            continue;
        }
        throw new Error(`Unexpected patch header: "${line.slice(0, 80)}". Expected *** Add File:, *** Update File:, or *** Delete File:.`);
    }
    if (operations.length === 0) {
        throw new Error('Patch contains zero file operations.');
    }
    return operations;
}
function findSequenceIndex(haystack, needle, startIndex, relaxedWhitespace) {
    if (needle.length === 0)
        return startIndex;
    const maxStart = haystack.length - needle.length;
    for (let pos = Math.max(0, startIndex); pos <= maxStart; pos++) {
        let matched = true;
        for (let j = 0; j < needle.length; j++) {
            const a = haystack[pos + j];
            const b = needle[j];
            if (relaxedWhitespace ? a.trim() !== b.trim() : a !== b) {
                matched = false;
                break;
            }
        }
        if (matched)
            return pos;
    }
    return -1;
}
export function applyHunksToText(originalContent, hunks, label) {
    const eol = originalContent.includes('\r\n') ? '\r\n' : '\n';
    const hadTrailingNewline = originalContent.endsWith('\n');
    const normalized = originalContent.replace(/\r\n/g, '\n');
    const lines = normalized.length === 0
        ? []
        : (hadTrailingNewline ? normalized.slice(0, -1).split('\n') : normalized.split('\n'));
    let searchCursor = 0;
    for (let hIdx = 0; hIdx < hunks.length; hIdx++) {
        const hunk = hunks[hIdx];
        const expectedOld = [];
        const replacement = [];
        for (const entry of hunk.lines) {
            if (entry.kind === ' ' || entry.kind === '-')
                expectedOld.push(entry.text);
            if (entry.kind === ' ' || entry.kind === '+')
                replacement.push(entry.text);
        }
        if (expectedOld.length === 0) {
            // Pure insertion hunk
            lines.splice(searchCursor, 0, ...replacement);
            searchCursor += replacement.length;
            continue;
        }
        let matchIdx = findSequenceIndex(lines, expectedOld, searchCursor, false);
        if (matchIdx === -1 && searchCursor > 0) {
            matchIdx = findSequenceIndex(lines, expectedOld, 0, false);
        }
        if (matchIdx === -1) {
            matchIdx = findSequenceIndex(lines, expectedOld, searchCursor, true);
        }
        if (matchIdx === -1 && searchCursor > 0) {
            matchIdx = findSequenceIndex(lines, expectedOld, 0, true);
        }
        if (matchIdx === -1) {
            throw new Error(`Hunk #${hIdx + 1} failed to match in "${label}". No files were modified (atomic abort).`);
        }
        lines.splice(matchIdx, expectedOld.length, ...replacement);
        searchCursor = matchIdx + replacement.length;
    }
    if (lines.length === 0)
        return '';
    return lines.join(eol) + (hadTrailingNewline ? eol : '');
}
export function patchContainsFileDeletion(rawPatch) {
    if (typeof rawPatch !== 'string')
        return false;
    return /(?:^|\r?\n)\*\*\* Delete File:\s*\S/.test(rawPatch);
}
export const applyPatch = {
    schema: {
        name: 'apply_patch',
        description: 'Apply an atomic multi-file patch (*** Begin Patch / *** Add File: / *** Update File: / *** Move to: / *** Delete File: / *** End Patch). Validates all hunks before modifying disk and rolls back on failure.',
        parameters: {
            type: 'object',
            properties: {
                patch: {
                    type: 'string',
                    description: 'Complete multi-file patch text delimited by *** Begin Patch and *** End Patch.'
                }
            },
            required: ['patch']
        }
    },
    async execute(args = {}, context = {}) {
        try {
            const safeArgs = args && typeof args === 'object' ? args : {};
            const ops = parsePatchText(String(safeArgs.patch ?? ''));
            const scope = resolveToolWorkspaceRoots(context);
            const workspaceRoot = scope.primaryRoot || process.cwd();
            // Phase 1: Validate every operation and compute all updated contents in memory
            const planned = [];
            const stagedContents = new Map();
            for (const op of ops) {
                if (op.type === 'add') {
                    const target = await assertSafeWorkspaceOutput(op.path, context);
                    if (isCredentialPath(target)) {
                        return { success: false, error: `Refusing to write protected credential path: ${sanitizeToolText(op.path, 160)}` };
                    }
                    const existing = await fs.lstat(target).catch((err) => {
                        if (err.code === 'ENOENT')
                            return null;
                        throw err;
                    });
                    if (existing) {
                        return { success: false, error: `Add File target already exists: ${sanitizeToolText(op.path, 160)}. Use *** Update File: instead.` };
                    }
                    stagedContents.set(target, op.content);
                    planned.push({
                        kind: 'write',
                        targetPath: target,
                        content: op.content,
                        mode: 0o644,
                        existedBefore: false,
                        displayPath: op.path
                    });
                    continue;
                }
                if (op.type === 'delete') {
                    const target = resolveScopedPath(op.path, context);
                    if (isCredentialPath(target)) {
                        return { success: false, error: `Refusing to delete protected credential path: ${sanitizeToolText(op.path, 160)}` };
                    }
                    const stat = await fs.lstat(target);
                    if (stat.isSymbolicLink() || !stat.isFile()) {
                        return { success: false, error: `Refusing to delete symlink or non-regular file: ${sanitizeToolText(op.path, 160)}` };
                    }
                    const prev = stat.size <= MAX_SOURCE_FILE_BYTES ? await fs.readFile(target, 'utf8') : undefined;
                    planned.push({
                        kind: 'delete',
                        targetPath: target,
                        mode: stat.mode & 0o777,
                        existedBefore: true,
                        previousContent: prev,
                        displayPath: op.path
                    });
                    continue;
                }
                // Update (and optional move)
                const source = resolveScopedPath(op.path, context);
                if (isCredentialPath(source)) {
                    return { success: false, error: `Refusing to modify protected credential path: ${sanitizeToolText(op.path, 160)}` };
                }
                const stat = await fs.lstat(source);
                if (stat.isSymbolicLink() || !stat.isFile()) {
                    return { success: false, error: `Refusing to update symlink or non-regular file: ${sanitizeToolText(op.path, 160)}` };
                }
                if (stat.size > MAX_SOURCE_FILE_BYTES) {
                    return { success: false, error: `File exceeds patch size ceiling (${MAX_SOURCE_FILE_BYTES} bytes): ${sanitizeToolText(op.path, 160)}` };
                }
                const previousContent = stagedContents.has(source)
                    ? stagedContents.get(source)
                    : await fs.readFile(source, 'utf8');
                const nextContent = op.hunks.length > 0
                    ? applyHunksToText(previousContent, op.hunks, op.path)
                    : previousContent;
                if (op.moveTo) {
                    const dest = await assertSafeWorkspaceOutput(op.moveTo, context);
                    if (isCredentialPath(dest)) {
                        return { success: false, error: `Refusing to move file into protected credential path: ${sanitizeToolText(op.moveTo, 160)}` };
                    }
                    stagedContents.set(dest, nextContent);
                    planned.push({
                        kind: 'move',
                        sourcePath: source,
                        targetPath: dest,
                        content: nextContent,
                        mode: stat.mode & 0o777,
                        existedBefore: true,
                        previousContent,
                        displayPath: `${op.path} -> ${op.moveTo}`
                    });
                }
                else {
                    stagedContents.set(source, nextContent);
                    planned.push({
                        kind: 'write',
                        targetPath: source,
                        content: nextContent,
                        mode: stat.mode & 0o777,
                        existedBefore: true,
                        previousContent,
                        displayPath: op.path
                    });
                }
            }
            // Phase 2: Commit atomically with rollback on any I/O failure
            const applied = [];
            try {
                for (const step of planned) {
                    if (step.kind === 'write') {
                        await fs.mkdir(path.dirname(step.targetPath), { recursive: true });
                        atomicWriteFileSync(step.targetPath, step.content ?? '', { encoding: 'utf8', mode: step.mode });
                    }
                    else if (step.kind === 'move') {
                        await fs.mkdir(path.dirname(step.targetPath), { recursive: true });
                        const isCaseOnlyRename = Boolean(step.sourcePath
                            && step.sourcePath !== step.targetPath
                            && step.sourcePath.toLowerCase() === step.targetPath.toLowerCase());
                        if (isCaseOnlyRename && step.sourcePath) {
                            // Two-step temp rename avoids unlinking the newly written target on case-insensitive APFS/NTFS
                            const tempHop = path.join(path.dirname(step.targetPath), `.causyne-rename-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`);
                            await fs.rename(step.sourcePath, tempHop);
                            try {
                                atomicWriteFileSync(tempHop, step.content ?? '', { encoding: 'utf8', mode: step.mode });
                                await fs.rename(tempHop, step.targetPath);
                            }
                            catch (hopErr) {
                                await fs.rename(tempHop, step.sourcePath).catch(() => { });
                                throw hopErr;
                            }
                        }
                        else {
                            atomicWriteFileSync(step.targetPath, step.content ?? '', { encoding: 'utf8', mode: step.mode });
                            if (step.sourcePath && step.sourcePath !== step.targetPath) {
                                await fs.unlink(step.sourcePath);
                            }
                        }
                    }
                    else if (step.kind === 'delete') {
                        await fs.unlink(step.targetPath);
                    }
                    applied.push(step);
                }
            }
            catch (commitErr) {
                // Best-effort rollback in reverse order
                for (let r = applied.length - 1; r >= 0; r--) {
                    const done = applied[r];
                    try {
                        if (done.kind === 'write') {
                            if (done.existedBefore && done.previousContent !== undefined) {
                                atomicWriteFileSync(done.targetPath, done.previousContent, { encoding: 'utf8', mode: done.mode });
                            }
                            else if (!done.existedBefore) {
                                await fs.unlink(done.targetPath).catch(() => { });
                            }
                        }
                        else if (done.kind === 'move' && done.sourcePath) {
                            if (done.previousContent !== undefined) {
                                atomicWriteFileSync(done.sourcePath, done.previousContent, { encoding: 'utf8', mode: done.mode });
                            }
                            if (done.targetPath !== done.sourcePath) {
                                await fs.unlink(done.targetPath).catch(() => { });
                            }
                        }
                        else if (done.kind === 'delete' && done.previousContent !== undefined) {
                            atomicWriteFileSync(done.targetPath, done.previousContent, { encoding: 'utf8', mode: done.mode });
                        }
                    }
                    catch { /* rollback best-effort */ }
                }
                return { success: false, error: `Patch commit failed and rolled back: ${sanitizeToolError(commitErr)}` };
            }
            // Phase 3: Fail-open post-edit LSP diagnostics on written/moved targets
            const diagBlocks = [];
            for (const step of applied) {
                if (step.kind === 'delete')
                    continue;
                const diags = await collectActivePostEditDiagnostics(step.targetPath, workspaceRoot, step.content);
                if (diags.length > 0) {
                    diagBlocks.push(formatDiagnosticsCompact(diags, workspaceRoot));
                }
            }
            const summaryLines = [
                `Patch applied atomically (${applied.length} file operation(s)):`,
                ...applied.map((s) => {
                    const tag = s.kind === 'delete' ? 'D' : (s.kind === 'move' ? 'R' : (s.existedBefore ? 'M' : 'A'));
                    return `  [${tag}] ${sanitizeToolText(s.displayPath, 240)}`;
                })
            ];
            if (diagBlocks.length > 0) {
                summaryLines.push('', '[LSP Diagnostics]', ...diagBlocks);
            }
            return { success: true, output: summaryLines.join('\n') };
        }
        catch (err) {
            return { success: false, error: sanitizeToolError(err) };
        }
    }
};
