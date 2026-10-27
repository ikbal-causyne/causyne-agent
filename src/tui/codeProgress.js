import { panel } from './block.js';
import { safeDisplay, truncate, padEnd } from './text.js';
// The terminal theme is still a standalone JavaScript module in the TS migration.
// @ts-expect-error theme.js has no TypeScript declaration yet.
import { COLOR_DEPTH, IS_LIGHT, paint } from './theme.js';
import { diffLines, MAX_SIDE_LINES } from './diff.js';
import fs from 'node:fs';
import path from 'node:path';
export const CODE_PANEL_LINES = 10;
const MAX_STREAM_PREVIEW_CHARS = 256_000;
const FILE_TOOLS = {
    fs_write: 'Creating', fs_edit: 'Editing', MultiEdit: 'Editing',
    'fs.write': 'Creating', 'fs.edit': 'Editing',
    fs_delete: 'Removing', fs_move: 'Moving',
    write_file: 'Creating', edit_file: 'Editing', delete_file: 'Removing',
    create_file: 'Creating', new_file: 'Creating',
    remove_file: 'Removing', unlink: 'Removing', move_file: 'Moving',
    replace_file_content: 'Editing', multi_replace_file_content: 'Editing',
    apply_patch: 'Editing', patch: 'Editing', str_replace_editor: 'Editing',
    WriteFile: 'Creating', EditFile: 'Editing', DeleteFile: 'Removing',
    CreateFile: 'Creating', RemoveFile: 'Removing', MoveFile: 'Moving',
    ReplaceFileContent: 'Editing', MultiReplaceFileContent: 'Editing'
};
function stringField(value) {
    return typeof value === 'string' ? value : '';
}
function codeFromArgs(args) {
    const direct = args.content ?? args.Content ?? args.CodeContent ?? args.codeContent ?? args.code ?? args.Code
        ?? args.new_string ?? args.new_str ?? args.newText ?? args.NewText ?? args.replaceContent ?? args.ReplaceContent
        ?? args.replacementContent ?? args.ReplacementContent ?? args.replacement_content ?? args.text ?? args.Text
        ?? args.after ?? args.After;
    if (typeof direct === 'string')
        return direct;
    const edits = args.edits ?? args.ReplacementChunks ?? args.chunks ?? args.Chunks;
    if (Array.isArray(edits)) {
        return edits.map((item) => {
            if (!item || typeof item !== 'object')
                return '';
            const entry = item;
            return stringField(entry.new_string ?? entry.new_str ?? entry.newText ?? entry.NewText
                ?? entry.replaceContent ?? entry.ReplaceContent ?? entry.replacementContent
                ?? entry.ReplacementContent ?? entry.replacement_content ?? entry.content ?? entry.Content
                ?? entry.text ?? entry.Text ?? entry.after ?? entry.After);
        }).join('\n');
    }
    return '';
}
function previousCodeFromArgs(args) {
    const direct = args.old_string ?? args.old_str ?? args.oldText ?? args.OldText
        ?? args.searchContent ?? args.SearchContent ?? args.targetContent ?? args.TargetContent
        ?? args.target_content ?? args.oldContent ?? args.OldContent ?? args.old_content
        ?? args.before ?? args.Before;
    if (typeof direct === 'string')
        return direct;
    const edits = args.edits ?? args.ReplacementChunks ?? args.chunks ?? args.Chunks;
    if (!Array.isArray(edits))
        return undefined;
    const previous = edits.map((item) => {
        if (!item || typeof item !== 'object')
            return undefined;
        const entry = item;
        const value = entry.old_string ?? entry.old_str ?? entry.oldText ?? entry.OldText
            ?? entry.searchContent ?? entry.SearchContent ?? entry.targetContent ?? entry.TargetContent
            ?? entry.target_content ?? entry.oldContent ?? entry.OldContent ?? entry.old_content
            ?? entry.before ?? entry.Before;
        return typeof value === 'string' ? value : undefined;
    });
    return previous.length && previous.every(value => value !== undefined) ? previous.join('\n') : undefined;
}
export function codeProgressFromAction(tool, args, id, phase = 'working', source = 'tool') {
    const operation = FILE_TOOLS[tool];
    if (!operation)
        return null;
    const path = stringField(args.path ?? args.Path ?? args.file_path ?? args.FilePath ?? args.AbsolutePath ?? args.TargetFile ?? args.source);
    const destination = stringField(args.destination);
    const label = path ? path.split(/[/\\]/).pop() || path : 'file';
    const description = operation === 'Moving' && destination
        ? `Moving ${label} to ${destination}`
        : `${operation} ${label}`;
    const before = previousCodeFromArgs(args);
    const code = codeFromArgs(args);
    return {
        type: 'code_progress', id, phase, operation,
        ...(path ? { path } : {}), description,
        ...(code || before !== undefined ? { code } : {}), ...(before !== undefined ? { before } : {}), source
    };
}
export class StreamingCodePreview {
    buffer = '';
    lastCode = '';
    lastSentAt = 0;
    truncated = false;
    accept(chunk, now = Date.now()) {
        if (!chunk)
            return null;
        this.buffer += chunk;
        if (this.buffer.length > MAX_STREAM_PREVIEW_CHARS) {
            this.buffer = this.buffer.slice(-MAX_STREAM_PREVIEW_CHARS);
            this.truncated = true;
        }
        if (now - this.lastSentAt < 100 && !chunk.includes('\n'))
            return null;
        const code = this.draftCode();
        if (!code.trim() || code === this.lastCode)
            return null;
        this.lastCode = code;
        this.lastSentAt = now;
        return { type: 'code_progress', id: 'model-draft', phase: 'draft',
            operation: 'Drafting', description: 'Writing code from the model stream', code,
            ...(this.truncated ? { codeTruncated: true } : {}), source: 'model' };
    }
    flush() {
        const code = this.draftCode();
        if (!code.trim() || code === this.lastCode)
            return null;
        this.lastCode = code;
        return { type: 'code_progress', id: 'model-draft', phase: 'draft',
            operation: 'Drafting', description: 'Writing code from the model stream', code,
            ...(this.truncated ? { codeTruncated: true } : {}), source: 'model' };
    }
    draftCode() {
        const fences = [...this.buffer.matchAll(/(?:^|\n)```[^\n]*\n([\s\S]*?)(?=\n```|$)/g)];
        const fenced = fences.at(-1)?.[1] || '';
        if (fenced.trim())
            return fenced;
        const start = this.buffer.lastIndexOf('<tool_call>');
        if (start < 0)
            return '';
        const call = this.buffer.slice(start);
        if (!/"name"\s*:\s*"(?:fs_write|fs_edit|MultiEdit|write_file|edit_file|create_file)"/.test(call))
            return '';
        const field = /"(?:content|new_string|replaceContent|newText)"\s*:\s*"/.exec(call);
        if (!field || field.index === undefined)
            return '';
        const raw = call.slice(field.index + field[0].length);
        let escaped = false;
        let end = raw.length;
        for (let i = 0; i < raw.length; i++) {
            if (escaped) {
                escaped = false;
                continue;
            }
            if (raw[i] === '\\') {
                escaped = true;
                continue;
            }
            if (raw[i] === '"') {
                end = i;
                break;
            }
        }
        const partial = raw.slice(0, end).replace(/\\$/u, '');
        try {
            return JSON.parse(`"${partial}"`);
        }
        catch {
            return partial.replace(/\\n/g, '\n');
        }
    }
}
/** Observe only a file named by a native edit action. No model calls are made. */
export class NativeCodeObserver {
    workspaceRoot;
    emit;
    active = new Map();
    constructor(workspaceRoot, emit) {
        this.workspaceRoot = workspaceRoot;
        this.emit = emit;
    }
    handle(event) {
        if (!event.path || !['Creating', 'Editing'].includes(event.operation))
            return;
        if (event.code !== undefined || event.phase === 'failed') {
            this.stop(event.id);
            return;
        }
        const target = path.resolve(this.workspaceRoot, event.path);
        if (event.phase === 'working') {
            this.stop(event.id);
            const previous = this.read(target);
            const timer = setInterval(() => this.poll(event.id), 100);
            timer.unref();
            this.active.set(event.id, { event, path: target, previous, lastShown: null, timer });
            return;
        }
        if (event.phase === 'done') {
            this.poll(event.id);
            const entry = this.active.get(event.id);
            const current = this.read(target);
            if (current !== null && (current !== entry?.previous || event.operation === 'Creating')) {
                this.emit({
                    ...event,
                    code: current,
                    ...(entry?.previous !== null && entry?.previous !== undefined && event.operation !== 'Creating'
                        ? { before: entry.previous }
                        : {})
                });
            }
        }
        this.stop(event.id);
    }
    poll(id) {
        const entry = this.active.get(id);
        if (!entry)
            return;
        const current = this.read(entry.path);
        if (current === null || current === entry.previous || current === entry.lastShown)
            return;
        entry.lastShown = current;
        this.emit({
            ...entry.event,
            code: current,
            ...(entry.previous !== null && entry.event.operation !== 'Creating' ? { before: entry.previous } : {})
        });
    }
    dispose() {
        for (const id of this.active.keys())
            this.stop(id);
    }
    stop(id) {
        const entry = this.active.get(id);
        if (entry)
            clearInterval(entry.timer);
        this.active.delete(id);
    }
    read(file) {
        try {
            const name = path.basename(file).toLowerCase();
            if (/^(\.env(?:\.|$)|.*\.(?:pem|key|p12|pfx)$)/u.test(name))
                return null;
            const stat = fs.lstatSync(file);
            if (!stat.isFile() || stat.size > 256_000)
                return null;
            const bytes = fs.readFileSync(file);
            if (bytes.includes(0))
                return null;
            return bytes.toString('utf8');
        }
        catch {
            return null;
        }
    }
}
function splitCodeLines(code) {
    if (!code)
        return [];
    const lines = code.replace(/\r\n?/g, '\n').split('\n');
    if (lines.at(-1) === '')
        lines.pop();
    return lines;
}
function previewLines(event) {
    if (event.code === undefined)
        return [];
    // When creating or drafting code, every line is new code (addition).
    // Even if a previous file existed on disk, the action is Creating/Drafting.
    if (event.operation === 'Creating' || event.operation === 'Drafting') {
        return splitCodeLines(event.code).map(text => ({ kind: 'add', text }));
    }
    // When removing, all lines are deletions.
    if (event.operation === 'Removing') {
        const text = event.before ?? event.code;
        return splitCodeLines(text).map(text => ({ kind: 'del', text }));
    }
    // When editing with known previous content:
    if (event.before !== undefined) {
        const oldLines = splitCodeLines(event.before);
        const newLines = splitCodeLines(event.code);
        let prefix = 0;
        while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix])
            prefix++;
        let suffix = 0;
        while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix
            && oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1])
            suffix++;
        const changedOld = oldLines.slice(prefix, oldLines.length - suffix);
        const changedNew = newLines.slice(prefix, newLines.length - suffix);
        if (changedOld.length === 0) {
            return [
                ...oldLines.slice(0, prefix).map(text => ({ kind: 'ctx', text })),
                ...changedNew.map(text => ({ kind: 'add', text })),
                ...oldLines.slice(oldLines.length - suffix).map(text => ({ kind: 'ctx', text }))
            ];
        }
        if (changedNew.length === 0) {
            return [
                ...oldLines.slice(0, prefix).map(text => ({ kind: 'ctx', text })),
                ...changedOld.map(text => ({ kind: 'del', text })),
                ...oldLines.slice(oldLines.length - suffix).map(text => ({ kind: 'ctx', text }))
            ];
        }
        const result = diffLines(changedOld.join('\n'), changedNew.join('\n'));
        const ops = [...result.ops];
        // If diff was truncated due to exceeding MAX_SIDE_LINES, preserve remaining lines as del/add rather than losing them
        if (result.truncated) {
            if (changedOld.length > MAX_SIDE_LINES) {
                for (let i = MAX_SIDE_LINES; i < changedOld.length; i++) {
                    ops.push({ kind: 'del', text: changedOld[i] });
                }
            }
            if (changedNew.length > MAX_SIDE_LINES) {
                for (let j = MAX_SIDE_LINES; j < changedNew.length; j++) {
                    ops.push({ kind: 'add', text: changedNew[j] });
                }
            }
        }
        return [
            ...oldLines.slice(0, prefix).map(text => ({ kind: 'ctx', text })),
            ...ops,
            ...oldLines.slice(oldLines.length - suffix).map(text => ({ kind: 'ctx', text }))
        ];
    }
    // Editing without evidenced 'before': preserve existing test contract by rendering lines as ctx
    return splitCodeLines(event.code).map(text => ({ kind: 'ctx', text }));
}
export function codePreviewLineCount(event) {
    return previewLines(event).length;
}
export function defaultPreviewStart(event) {
    const codeLines = previewLines(event);
    const maxStart = Math.max(0, codeLines.length - CODE_PANEL_LINES);
    if (event.operation === 'Editing') {
        const firstChange = codeLines.findIndex(l => l.kind === 'add' || l.kind === 'del');
        if (firstChange >= 0) {
            return Math.max(0, Math.min(maxStart, firstChange - 2));
        }
    }
    return maxStart;
}
function highlightCode(kind, text, width) {
    const marker = kind === 'add' ? '+' : kind === 'del' ? '-' : ' ';
    const role = kind === 'add' ? 'success' : kind === 'del' ? 'danger' : 'muted';
    const body = padEnd(truncate(safeDisplay(text), Math.max(1, width - 2)), Math.max(1, width - 2));
    if (kind === 'ctx' || COLOR_DEPTH < 256)
        return paint(role, marker) + ' ' + body;
    // A low-contrast tint one step above the panel surface. The colored marker
    // remains readable even when a terminal can only approximate the tint.
    const background = COLOR_DEPTH >= 16777216
        ? kind === 'add' ? (IS_LIGHT ? '48;2;231;239;220' : '48;2;32;42;32')
            : (IS_LIGHT ? '48;2;245;230;230' : '48;2;47;32;34')
        : kind === 'add' ? (IS_LIGHT ? '48;5;194' : '48;5;22')
            : (IS_LIGHT ? '48;5;224' : '48;5;52');
    return paint(role, marker) + `\x1b[${background}m ${body}\x1b[49m`;
}
/** Render a bounded, resize-safe panel. The terminal theme supplies rounded corners. */
export function renderCodeProgress(event, width, modelNote = '', startLine) {
    const safeWidth = Math.max(12, Math.floor(width) || 80);
    const inner = safeWidth - 4;
    const title = `${event.phase === 'done' ? '✓ ' : event.phase === 'failed' ? '× ' : ''}code · ${event.operation.toLowerCase()}`;
    const rows = [truncate(safeDisplay(event.description), inner)];
    if (event.path)
        rows.push(truncate(safeDisplay(event.path), inner));
    if (modelNote)
        rows.push(truncate(`model note: ${safeDisplay(modelNote)}`, inner));
    const codeLines = previewLines(event);
    const maxStart = Math.max(0, codeLines.length - CODE_PANEL_LINES);
    const start = startLine === undefined ? defaultPreviewStart(event) : Math.max(0, Math.min(Math.floor(startLine), maxStart));
    const visible = codeLines.slice(start, start + CODE_PANEL_LINES);
    if (visible.length) {
        rows.push('');
        for (const line of visible)
            rows.push(highlightCode(line.kind, line.text, inner));
        if (codeLines.length > CODE_PANEL_LINES) {
            rows.push(truncate(`lines ${start + 1}-${start + visible.length} of ${codeLines.length} · scroll over code`, inner));
        }
        if (event.codeTruncated)
            rows.push(truncate('Earlier draft content exceeded the preview limit', inner));
    }
    return panel(rows, { width: safeWidth, title, role: event.phase === 'failed' ? 'danger' : 'rule' });
}
