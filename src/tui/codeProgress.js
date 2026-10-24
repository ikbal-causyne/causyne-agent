import { panel } from './block.js';
import { safeDisplay, truncate } from './text.js';
import fs from 'node:fs';
import path from 'node:path';
const FILE_TOOLS = {
    fs_write: 'Creating', fs_edit: 'Editing', MultiEdit: 'Editing',
    'fs.write': 'Creating', 'fs.edit': 'Editing',
    fs_delete: 'Removing', fs_move: 'Moving',
    write_file: 'Creating', edit_file: 'Editing', delete_file: 'Removing',
    replace_file_content: 'Editing', multi_replace_file_content: 'Editing',
    WriteFile: 'Creating', EditFile: 'Editing', DeleteFile: 'Removing',
    ReplaceFileContent: 'Editing', MultiReplaceFileContent: 'Editing'
};
function stringField(value) {
    return typeof value === 'string' ? value : '';
}
function codeFromArgs(args) {
    const direct = args.content ?? args.Content ?? args.CodeContent ?? args.code ?? args.new_string ?? args.newText ?? args.replaceContent ?? args.ReplacementContent;
    if (typeof direct === 'string')
        return direct.slice(-12_000);
    const edits = args.edits ?? args.ReplacementChunks;
    if (Array.isArray(edits)) {
        return edits.map((item) => {
            if (!item || typeof item !== 'object')
                return '';
            const entry = item;
            return stringField(entry.new_string ?? entry.newText ?? entry.replaceContent ?? entry.ReplacementContent ?? entry.content);
        }).filter(Boolean).join('\n').slice(-12_000);
    }
    return '';
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
    const code = codeFromArgs(args);
    return {
        type: 'code_progress', id, phase, operation,
        ...(path ? { path } : {}), description,
        ...(code ? { code } : {}), source
    };
}
export class StreamingCodePreview {
    buffer = '';
    lastCode = '';
    lastSentAt = 0;
    accept(chunk, now = Date.now()) {
        if (!chunk)
            return null;
        this.buffer = (this.buffer + chunk).slice(-24_000);
        const code = this.draftCode();
        if (!code.trim() || code === this.lastCode)
            return null;
        if (now - this.lastSentAt < 100 && !chunk.includes('\n'))
            return null;
        this.lastCode = code;
        this.lastSentAt = now;
        return { type: 'code_progress', id: 'model-draft', phase: 'draft',
            operation: 'Drafting', description: 'Writing code from the model stream', code, source: 'model' };
    }
    flush() {
        const code = this.draftCode();
        if (!code.trim() || code === this.lastCode)
            return null;
        this.lastCode = code;
        return { type: 'code_progress', id: 'model-draft', phase: 'draft',
            operation: 'Drafting', description: 'Writing code from the model stream', code, source: 'model' };
    }
    draftCode() {
        const fences = [...this.buffer.matchAll(/(?:^|\n)```[^\n]*\n([\s\S]*?)(?=\n```|$)/g)];
        const fenced = fences.at(-1)?.[1]?.slice(-12_000) || '';
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
            return JSON.parse(`"${partial}"`).slice(-12_000);
        }
        catch {
            return partial.replace(/\\n/g, '\n').slice(-12_000);
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
        if (event.code || event.phase === 'failed') {
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
                this.emit({ ...event, code: current.slice(-12_000) });
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
        this.emit({ ...entry.event, code: current.slice(-12_000) });
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
/** Render a bounded, resize-safe panel. The terminal theme supplies rounded corners. */
export function renderCodeProgress(event, width, modelNote = '') {
    const safeWidth = Math.max(12, Math.floor(width) || 80);
    const inner = safeWidth - 4;
    const title = `${event.phase === 'done' ? '✓ ' : event.phase === 'failed' ? '× ' : ''}code · ${event.operation.toLowerCase()}`;
    const rows = [truncate(safeDisplay(event.description), inner)];
    if (event.path)
        rows.push(truncate(safeDisplay(event.path), inner));
    if (modelNote)
        rows.push(truncate(`model note: ${safeDisplay(modelNote)}`, inner));
    const codeLines = String(event.code || '').split(/\r?\n/);
    const visible = event.code ? codeLines.slice(-10) : [];
    if (event.code && codeLines.length > visible.length)
        rows.push(`… ${codeLines.length - visible.length} earlier lines`);
    if (visible.length) {
        rows.push('');
        for (const line of visible)
            rows.push(truncate(safeDisplay(line), inner));
    }
    return panel(rows, { width: safeWidth, title, role: event.phase === 'failed' ? 'danger' : 'rule' });
}
