import fs from 'node:fs';
import path from 'node:path';
import { isPhysicalPathAllowed } from '../../agent/workspaceBoundary.js';
import { SAFE_SESSION_ID_RE } from './security.js';
import { buildSynthesizedWriteHunk, resolveWorkspaceRelativePath } from './workspaceFiles.js';
export const MUTATING_FILE_TOOLS = new Set([
    'fs_write', 'fs_edit', 'multi_edit', 'apply_patch', 'fs_delete', 'fs_move',
    'write_file', 'edit_file', 'write', 'edit', 'multiedit', 'replace_file_content',
    'multi_replace_file_content', 'write_to_file', 'create_file', 'document_forge',
    'ui_forge', 'screenshot', 'generate_media_via_api', 'code_verify_syntax'
]);
const SHELL_TOOLS = new Set(['sysrun', 'bash', 'shell', 'run_command', 'execute_command']);
export function normalizeWorkspaceRelCandidate(workspaceRoot, raw, baseDir) {
    if (typeof raw !== 'string')
        return null;
    let trimmed = raw.trim().replace(/^["'`]+|["'`]+$/g, '');
    if (!trimmed || trimmed.includes('\0') || trimmed.length > 500)
        return null;
    if (/^https?:\/\//i.test(trimmed))
        return null;
    if (trimmed.toLowerCase().startsWith('file://')) {
        trimmed = trimmed.slice('file://'.length);
        const hashIdx = trimmed.indexOf('#');
        if (hashIdx >= 0)
            trimmed = trimmed.slice(0, hashIdx);
        const queryIdx = trimmed.indexOf('?');
        if (queryIdx >= 0)
            trimmed = trimmed.slice(0, queryIdx);
        try {
            trimmed = decodeURIComponent(trimmed);
        }
        catch {
            // Keep raw decoded string if percent encoding is malformed.
        }
        if (/^\/[A-Za-z]:[\\/]/.test(trimmed)) {
            trimmed = trimmed.slice(1);
        }
    }
    else {
        const lineAnchor = trimmed.match(/^(.+?\.[a-zA-Z0-9]{1,8})#L\d+(?:-L?\d+)?$/);
        if (lineAnchor?.[1])
            trimmed = lineAnchor[1];
    }
    const escNl = trimmed.indexOf('\\n');
    if (escNl >= 0)
        trimmed = trimmed.slice(0, escNl);
    trimmed = trimmed.replace(/[),.;:]+$/g, '').trim();
    if (!trimmed || trimmed === '.' || trimmed === '/')
        return null;
    let rel = trimmed;
    if (path.isAbsolute(trimmed)) {
        const absNorm = path.resolve(trimmed);
        if (!isPhysicalPathAllowed(absNorm, [workspaceRoot], false))
            return null;
        rel = path.relative(workspaceRoot, absNorm);
    }
    else if (baseDir && path.isAbsolute(baseDir)) {
        const absNorm = path.resolve(baseDir, trimmed);
        if (!isPhysicalPathAllowed(absNorm, [workspaceRoot], false))
            return null;
        rel = path.relative(workspaceRoot, absNorm);
    }
    const abs = resolveWorkspaceRelativePath(workspaceRoot, rel);
    if (!abs)
        return null;
    const normalized = path.relative(workspaceRoot, abs).split(path.sep).join('/');
    return normalized && !normalized.startsWith('..') ? normalized : null;
}
function tokenizeSimpleShell(command) {
    const tokens = [];
    let current = '';
    let quote = null;
    for (let i = 0; i < command.length; i += 1) {
        const ch = command[i];
        if (quote) {
            if (ch === quote)
                quote = null;
            else
                current += ch;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            continue;
        }
        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
            if (current) {
                tokens.push(current);
                current = '';
            }
            continue;
        }
        if (ch === ';' || ch === '|') {
            if (current) {
                tokens.push(current);
                current = '';
            }
            tokens.push(ch);
            continue;
        }
        if (ch === '&' && command[i + 1] === '&') {
            if (current) {
                tokens.push(current);
                current = '';
            }
            tokens.push('&&');
            i += 1;
            continue;
        }
        current += ch;
    }
    if (current)
        tokens.push(current);
    return tokens;
}
function extractShellWriteTargets(command, workspaceRoot, cwdArg) {
    const found = [];
    let curDir = workspaceRoot;
    if (typeof cwdArg === 'string' && cwdArg.trim()) {
        const resolvedCwd = path.isAbsolute(cwdArg.trim())
            ? path.resolve(cwdArg.trim())
            : path.resolve(workspaceRoot, cwdArg.trim());
        if (isPhysicalPathAllowed(resolvedCwd, [workspaceRoot], false))
            curDir = resolvedCwd;
    }
    const tokens = tokenizeSimpleShell(command);
    for (let i = 0; i < tokens.length; i += 1) {
        const tok = tokens[i];
        if (tok === 'cd' && tokens[i + 1]) {
            const nextDir = tokens[i + 1];
            const resolved = path.isAbsolute(nextDir)
                ? path.resolve(nextDir)
                : path.resolve(curDir, nextDir);
            if (isPhysicalPathAllowed(resolved, [workspaceRoot], false))
                curDir = resolved;
            i += 1;
            continue;
        }
        if ((tok === '-o' || tok === '--output' || tok === '>' || tok === '>>' || tok === 'tee') && tokens[i + 1]) {
            const target = tokens[i + 1];
            if (target !== '/dev/null' && !target.startsWith('-')) {
                const norm = normalizeWorkspaceRelCandidate(workspaceRoot, target, curDir);
                if (norm)
                    found.push(norm);
            }
            i += 1;
            continue;
        }
        if (tok === 'screencapture') {
            let j = i + 1;
            while (j < tokens.length && tokens[j] !== ';' && tokens[j] !== '&&' && tokens[j] !== '|') {
                const arg = tokens[j];
                if (!arg.startsWith('-')) {
                    const norm = normalizeWorkspaceRelCandidate(workspaceRoot, arg, curDir);
                    if (norm)
                        found.push(norm);
                }
                j += 1;
            }
            i = j - 1;
        }
    }
    return found;
}
function extractPatchPathsFromText(patchText) {
    const found = [];
    for (const line of patchText.split(/\r?\n/)) {
        const m = line.match(/^\*\*\*\s+(?:Add|Update|Delete)\s+File:\s+(.+)$/);
        if (m?.[1])
            found.push(m[1].trim());
        const diffM = line.match(/^(?:\+\+\+|---)\s+[ab]\/(.+)$/);
        if (diffM?.[1])
            found.push(diffM[1].trim());
    }
    return found;
}
function buildSynthesizedEditHunk(oldStr, newStr) {
    const oldLines = oldStr ? oldStr.split(/\r?\n/) : [];
    const newLines = newStr ? newStr.split(/\r?\n/) : [];
    const diffLines = [];
    for (const ln of oldLines.slice(0, 80))
        diffLines.push(`-${ln}`);
    for (const ln of newLines.slice(0, 80))
        diffLines.push(`+${ln}`);
    return {
        additions: newLines.length,
        deletions: oldLines.length,
        hunks: diffLines.length > 0
            ? [{ header: `@@ -1,${oldLines.length} +1,${newLines.length} @@`, lines: diffLines }]
            : []
    };
}
function hasFileExtension(relPath) {
    const base = path.posix.basename(relPath);
    const dot = base.lastIndexOf('.');
    return dot > 0 && dot < base.length - 1 && base.length - dot <= 10;
}
export function extractSessionFileEvidence(messages, workspaceRoot) {
    const evidenceMap = new Map();
    const touchedDirs = new Set();
    const recordFile = (raw, opts = {}) => {
        const norm = normalizeWorkspaceRelCandidate(workspaceRoot, raw, opts.baseDir);
        if (!norm)
            return;
        const dir = path.posix.dirname(norm);
        if (dir && dir !== '.')
            touchedDirs.add(dir);
        const existing = evidenceMap.get(norm);
        if (!existing) {
            evidenceMap.set(norm, {
                path: norm,
                status: opts.status ?? 'added',
                bytesWritten: opts.bytesWritten,
                additions: opts.additions ?? 0,
                deletions: opts.deletions ?? 0,
                hunks: opts.hunks ?? []
            });
            return;
        }
        if (opts.status === 'deleted')
            existing.status = 'deleted';
        else if (opts.status === 'modified' && existing.status !== 'added')
            existing.status = 'modified';
        if (typeof opts.bytesWritten === 'number' && opts.bytesWritten > 0) {
            existing.bytesWritten = opts.bytesWritten;
        }
        if (opts.hunks && opts.hunks.length > 0) {
            existing.hunks = opts.hunks;
            existing.additions = opts.additions ?? existing.additions;
            existing.deletions = opts.deletions ?? existing.deletions;
        }
    };
    const assistantBacktickCandidates = [];
    for (const msg of messages) {
        const rec = msg;
        const toolCalls = Array.isArray(rec.tool_calls)
            ? rec.tool_calls
            : [];
        for (const tc of toolCalls) {
            const fn = (tc.function && typeof tc.function === 'object' ? tc.function : tc);
            const name = typeof fn.name === 'string' ? fn.name.trim().toLowerCase() : '';
            if (!name)
                continue;
            let args = null;
            if (typeof fn.arguments === 'string') {
                try {
                    const parsed = JSON.parse(fn.arguments);
                    if (parsed && typeof parsed === 'object')
                        args = parsed;
                }
                catch {
                    args = null;
                }
            }
            else if (fn.arguments && typeof fn.arguments === 'object') {
                args = fn.arguments;
            }
            if (!args)
                continue;
            if (MUTATING_FILE_TOOLS.has(name)) {
                const status = name === 'fs_delete'
                    ? 'deleted'
                    : name.includes('edit') || name.includes('patch') || name.includes('replace')
                        ? 'modified'
                        : 'added';
                const synthWrite = typeof args.content === 'string' && args.content.length > 0
                    ? buildSynthesizedWriteHunk(args.content)
                    : null;
                const synthEdit = (typeof args.old_string === 'string' || typeof args.new_string === 'string')
                    && (Boolean(args.old_string) || Boolean(args.new_string))
                    ? buildSynthesizedEditHunk(String(args.old_string || ''), String(args.new_string || ''))
                    : null;
                const pathKeys = [
                    'path', 'filePath', 'file_path', 'targetFile', 'target_path',
                    'filename', 'file', 'destination', 'outputFile', 'output_path', 'outputPath'
                ];
                for (const key of pathKeys) {
                    recordFile(args[key], {
                        status,
                        additions: synthWrite?.additions ?? synthEdit?.additions ?? 0,
                        deletions: synthEdit?.deletions ?? 0,
                        hunks: synthWrite?.hunks ?? synthEdit?.hunks ?? []
                    });
                }
                if (typeof args.patch === 'string') {
                    for (const p of extractPatchPathsFromText(args.patch)) {
                        recordFile(p, { status: 'modified' });
                    }
                }
                if (Array.isArray(args.edits)) {
                    for (const ed of args.edits) {
                        if (ed && typeof ed === 'object') {
                            recordFile(ed.path, { status: 'modified' });
                        }
                    }
                }
            }
            else if (name === 'browser_act' && Array.isArray(args.actions)) {
                for (const a of args.actions) {
                    if (a && typeof a === 'object') {
                        const actObj = a;
                        if (actObj.filePath)
                            recordFile(actObj.filePath, { status: 'modified' });
                        if (actObj.outputPath)
                            recordFile(actObj.outputPath, { status: 'added' });
                    }
                }
            }
            else if (SHELL_TOOLS.has(name) && typeof args.command === 'string') {
                for (const p of extractShellWriteTargets(args.command, workspaceRoot, args.cwd)) {
                    recordFile(p, { status: 'added' });
                }
            }
        }
        const extActions = Array.isArray(rec.external_actions)
            ? rec.external_actions
            : [];
        for (const act of extActions) {
            const name = typeof act.name === 'string' ? act.name.trim().toLowerCase() : '';
            if (!name)
                continue;
            if (MUTATING_FILE_TOOLS.has(name)) {
                recordFile(act.detail, { status: name.includes('edit') ? 'modified' : 'added' });
                const params = act.parameters && typeof act.parameters === 'object'
                    ? act.parameters
                    : null;
                if (params) {
                    for (const key of ['path', 'filePath', 'file_path', 'targetFile', 'filename', 'file', 'destination', 'outputPath']) {
                        recordFile(params[key], { status: name.includes('edit') ? 'modified' : 'added' });
                    }
                }
            }
            else if (SHELL_TOOLS.has(name) && typeof act.detail === 'string') {
                for (const p of extractShellWriteTargets(act.detail, workspaceRoot)) {
                    recordFile(p, { status: 'added' });
                }
            }
        }
        const rawText = typeof msg.content === 'string' ? msg.content : '';
        if (msg.role === 'tool' && rawText) {
            let toolText = rawText;
            try {
                const parsed = JSON.parse(rawText);
                if (parsed && typeof parsed === 'object' && typeof parsed.output === 'string') {
                    toolText = parsed.output;
                }
            }
            catch {
                // Keep plain text tool output.
            }
            for (const m of toolText.matchAll(/Atomically wrote (\d+) bytes to ([^\r\n"'}]+)/g)) {
                recordFile(m[2], { status: 'added', bytesWritten: Number(m[1]) || undefined });
            }
            for (const m of toolText.matchAll(/Saved (\d+)-byte screenshot to ([^\r\n"'}]+)/g)) {
                recordFile(m[2], { status: 'added', bytesWritten: Number(m[1]) || undefined });
            }
            for (const m of toolText.matchAll(/(?:Successfully edited|Successfully wrote|Created file|Patched)\s+([^\r\n"'}]+)/g)) {
                recordFile(m[1], { status: 'modified' });
            }
        }
        if (msg.role === 'assistant' && rawText) {
            for (const m of rawText.matchAll(/file:\/\/[^\s)\]"'<>]+/g)) {
                recordFile(m[0], { status: 'added' });
            }
            for (const m of rawText.matchAll(/`([^`\r\n]{3,240})`/g)) {
                const candidate = m[1];
                if (candidate.includes('/') && hasFileExtension(candidate) && !candidate.includes(' ')) {
                    assistantBacktickCandidates.push(candidate);
                }
            }
        }
    }
    for (const cand of assistantBacktickCandidates) {
        const norm = normalizeWorkspaceRelCandidate(workspaceRoot, cand);
        if (!norm || evidenceMap.has(norm))
            continue;
        const dir = path.posix.dirname(norm);
        const abs = resolveWorkspaceRelativePath(workspaceRoot, norm);
        const inTouchedDir = Boolean(dir && dir !== '.' && touchedDirs.has(dir));
        const existsUntrackedDotAsset = Boolean(abs && norm.startsWith('.') && fs.existsSync(abs));
        if (inTouchedDir || existsUntrackedDotAsset) {
            recordFile(norm, { status: 'added' });
        }
    }
    const allPaths = [...evidenceMap.keys()];
    for (const p of allPaths) {
        if (!hasFileExtension(p)) {
            const prefix = `${p}/`;
            if (allPaths.some((other) => other.startsWith(prefix))) {
                evidenceMap.delete(p);
            }
        }
    }
    return evidenceMap;
}
export function extractSessionTouchedFiles(messages, workspaceRoot) {
    return [...extractSessionFileEvidence(messages, workspaceRoot).keys()].sort();
}
function summarizeArgsTarget(args) {
    if (!args)
        return '';
    for (const key of ['path', 'filePath', 'file_path', 'file', 'command', 'query', 'url', 'skill_id']) {
        if (typeof args[key] === 'string' && String(args[key]).trim()) {
            return String(args[key]).trim().slice(0, 100);
        }
    }
    return '';
}
export function extractSessionDisplayMessages(messages) {
    const toolOutputsById = new Map();
    for (const msg of messages) {
        if (msg.role !== 'tool')
            continue;
        const rec = msg;
        const id = typeof rec.tool_call_id === 'string' ? rec.tool_call_id : '';
        if (!id)
            continue;
        const raw = typeof msg.content === 'string' ? msg.content : '';
        let failed = false;
        let summary = raw.trim().slice(0, 360);
        try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') {
                if (parsed.success === false || typeof parsed.error === 'string')
                    failed = true;
                if (typeof parsed.error === 'string')
                    summary = parsed.error.slice(0, 360);
                else if (typeof parsed.output === 'string')
                    summary = parsed.output.slice(0, 360);
            }
        }
        catch {
            // plain text tool output
        }
        toolOutputsById.set(id, { output: summary, failed });
    }
    const out = [];
    for (const msg of messages) {
        if (msg.role !== 'user' && msg.role !== 'assistant')
            continue;
        const rec = msg;
        let text = '';
        if (typeof msg.content === 'string') {
            text = msg.content;
        }
        else if (Array.isArray(msg.content)) {
            const parts = [];
            for (const block of msg.content) {
                if (block && typeof block === 'object' && typeof block.text === 'string') {
                    parts.push(String(block.text));
                }
            }
            text = parts.join('\n');
        }
        const trimmed = text.trim();
        if (msg.role === 'user') {
            if (!trimmed)
                continue;
            out.push({ role: 'user', content: trimmed });
            continue;
        }
        const steps = [];
        const extActions = Array.isArray(rec.external_actions)
            ? rec.external_actions
            : [];
        for (const act of extActions) {
            const rawName = typeof act.name === 'string' ? act.name.trim() : '';
            const rawDetail = typeof act.detail === 'string' ? act.detail.trim() : '';
            if (!rawName || rawName === 'true' || rawName === ':' || rawDetail === 'true' || rawDetail === ':')
                continue;
            steps.push({
                tool: rawName.replace(/^causyne[-_]browser[_:]/i, ''),
                target: rawDetail.slice(0, 100),
                status: act.status === 'failed' ? 'failed' : 'done'
            });
        }
        const toolCalls = Array.isArray(rec.tool_calls)
            ? rec.tool_calls
            : [];
        for (const tc of toolCalls) {
            const fn = (tc.function && typeof tc.function === 'object' ? tc.function : tc);
            const name = typeof fn.name === 'string' ? fn.name.trim() : '';
            if (!name || name === 'true' || name === ':')
                continue;
            let args = null;
            if (typeof fn.arguments === 'string') {
                try {
                    const parsed = JSON.parse(fn.arguments);
                    if (parsed && typeof parsed === 'object')
                        args = parsed;
                }
                catch {
                    args = null;
                }
            }
            else if (fn.arguments && typeof fn.arguments === 'object') {
                args = fn.arguments;
            }
            const tcId = typeof tc.id === 'string' ? tc.id : '';
            const matchedOut = tcId ? toolOutputsById.get(tcId) : undefined;
            steps.push({
                tool: name,
                target: summarizeArgsTarget(args),
                status: matchedOut?.failed ? 'failed' : 'done',
                ...(matchedOut?.output ? { output: matchedOut.output } : {})
            });
        }
        const rawReasoning = typeof rec.reasoning_content === 'string' ? rec.reasoning_content.trim() : '';
        const reasoning = rawReasoning ? rawReasoning.slice(0, 8000) : undefined;
        if (!trimmed && steps.length === 0 && !reasoning)
            continue;
        const msgBlocks = [];
        if (reasoning)
            msgBlocks.push({ kind: 'reasoning', content: reasoning });
        if (steps.length > 0)
            msgBlocks.push({ kind: 'steps', steps });
        if (trimmed)
            msgBlocks.push({ kind: 'text', content: trimmed });
        // Merge consecutive assistant messages between user turns while preserving chronological blocks.
        const prev = out.length > 0 ? out[out.length - 1] : null;
        if (prev && prev.role === 'assistant') {
            const prevBlocks = prev.blocks ? [...prev.blocks] : [];
            for (const blk of msgBlocks) {
                const lastBlk = prevBlocks.length > 0 ? prevBlocks[prevBlocks.length - 1] : null;
                if (blk.kind === 'steps' && lastBlk && lastBlk.kind === 'steps') {
                    lastBlk.steps = [...lastBlk.steps, ...blk.steps];
                }
                else if (blk.kind === 'reasoning' && lastBlk && lastBlk.kind === 'reasoning') {
                    lastBlk.content = `${lastBlk.content}\n\n${blk.content}`.slice(0, 8000);
                }
                else {
                    prevBlocks.push(blk);
                }
            }
            prev.blocks = prevBlocks;
            if (steps.length > 0)
                prev.steps = [...(prev.steps || []), ...steps];
            if (reasoning)
                prev.reasoning = prev.reasoning ? `${prev.reasoning}\n\n${reasoning}`.slice(0, 8000) : reasoning;
            if (trimmed)
                prev.content = prev.content ? `${prev.content}\n\n${trimmed}` : trimmed;
            continue;
        }
        out.push({
            role: 'assistant',
            content: trimmed,
            ...(reasoning ? { reasoning } : {}),
            ...(steps.length > 0 ? { steps } : {}),
            blocks: msgBlocks
        });
    }
    return out;
}
export function parseSessionIdRoute(pathname) {
    const prefix = '/api/sessions/';
    if (!pathname.startsWith(prefix))
        return null;
    const raw = pathname.slice(prefix.length);
    if (!raw || raw.includes('/'))
        return null;
    let decoded = '';
    try {
        decoded = decodeURIComponent(raw);
    }
    catch {
        return null;
    }
    return SAFE_SESSION_ID_RE.test(decoded) ? decoded : null;
}
export function parseSessionStreamRoute(pathname) {
    const prefix = '/api/sessions/';
    const suffix = '/stream';
    if (!pathname.startsWith(prefix) || !pathname.endsWith(suffix))
        return null;
    const raw = pathname.slice(prefix.length, pathname.length - suffix.length);
    if (!raw || raw.includes('/'))
        return null;
    let decoded = '';
    try {
        decoded = decodeURIComponent(raw);
    }
    catch {
        return null;
    }
    return SAFE_SESSION_ID_RE.test(decoded) ? decoded : null;
}
