import { panel } from './block.js';
import { safeDisplay, truncate, padEnd } from './text.js';
// The terminal theme is still a standalone JavaScript module in the TS migration.
// @ts-expect-error theme.js has no TypeScript declaration yet.
import { COLOR_DEPTH, IS_LIGHT, paint } from './theme.js';
import { diffLines } from './diff.js';
import fs from 'node:fs';
import path from 'node:path';

export type CodePhase = 'draft' | 'working' | 'done' | 'failed';

export interface CodeProgressEvent {
  [key: string]: unknown;
  type: 'code_progress';
  id: string;
  phase: CodePhase;
  operation: string;
  path?: string;
  description: string;
  code?: string;
  before?: string;
  codeTruncated?: boolean;
  source: 'model' | 'tool' | 'provider';
}

export const CODE_PANEL_LINES = 10;
const MAX_STREAM_PREVIEW_CHARS = 256_000;

const FILE_TOOLS: Record<string, string> = {
  fs_write: 'Creating', fs_edit: 'Editing', MultiEdit: 'Editing',
  'fs.write': 'Creating', 'fs.edit': 'Editing',
  fs_delete: 'Removing', fs_move: 'Moving',
  write_file: 'Creating', edit_file: 'Editing', delete_file: 'Removing',
  replace_file_content: 'Editing', multi_replace_file_content: 'Editing',
  WriteFile: 'Creating', EditFile: 'Editing', DeleteFile: 'Removing',
  ReplaceFileContent: 'Editing', MultiReplaceFileContent: 'Editing'
};

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function codeFromArgs(args: Record<string, unknown>): string {
  const direct = args.content ?? args.Content ?? args.CodeContent ?? args.code ?? args.new_string ?? args.newText ?? args.replaceContent ?? args.ReplacementContent;
  if (typeof direct === 'string') return direct;
  const edits = args.edits ?? args.ReplacementChunks;
  if (Array.isArray(edits)) {
    return edits.map((item: unknown) => {
      if (!item || typeof item !== 'object') return '';
      const entry = item as Record<string, unknown>;
      return stringField(entry.new_string ?? entry.newText ?? entry.replaceContent ?? entry.ReplacementContent ?? entry.content);
    }).join('\n');
  }
  return '';
}

function previousCodeFromArgs(args: Record<string, unknown>): string | undefined {
  const direct = args.old_string ?? args.oldText ?? args.searchContent ?? args.SearchContent;
  if (typeof direct === 'string') return direct;
  const edits = args.edits ?? args.ReplacementChunks;
  if (!Array.isArray(edits)) return undefined;
  const previous = edits.map((item: unknown) => {
    if (!item || typeof item !== 'object') return undefined;
    const entry = item as Record<string, unknown>;
    const value = entry.old_string ?? entry.oldText ?? entry.searchContent ?? entry.SearchContent;
    return typeof value === 'string' ? value : undefined;
  });
  return previous.length && previous.every(value => value !== undefined) ? previous.join('\n') : undefined;
}

export function codeProgressFromAction(
  tool: string,
  args: Record<string, unknown>,
  id: string,
  phase: CodePhase = 'working',
  source: CodeProgressEvent['source'] = 'tool'
): CodeProgressEvent | null {
  const operation = FILE_TOOLS[tool];
  if (!operation) return null;
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
  private buffer = '';
  private lastCode = '';
  private lastSentAt = 0;
  private truncated = false;

  accept(chunk: string, now = Date.now()): CodeProgressEvent | null {
    if (!chunk) return null;
    this.buffer += chunk;
    if (this.buffer.length > MAX_STREAM_PREVIEW_CHARS) {
      this.buffer = this.buffer.slice(-MAX_STREAM_PREVIEW_CHARS);
      this.truncated = true;
    }
    if (now - this.lastSentAt < 100 && !chunk.includes('\n')) return null;
    const code = this.draftCode();
    if (!code.trim() || code === this.lastCode) return null;
    this.lastCode = code;
    this.lastSentAt = now;
    return { type: 'code_progress', id: 'model-draft', phase: 'draft',
      operation: 'Drafting', description: 'Writing code from the model stream', code,
      ...(this.truncated ? { codeTruncated: true } : {}), source: 'model' };
  }

  flush(): CodeProgressEvent | null {
    const code = this.draftCode();
    if (!code.trim() || code === this.lastCode) return null;
    this.lastCode = code;
    return { type: 'code_progress', id: 'model-draft', phase: 'draft',
      operation: 'Drafting', description: 'Writing code from the model stream', code,
      ...(this.truncated ? { codeTruncated: true } : {}), source: 'model' };
  }

  private draftCode(): string {
    const fences = [...this.buffer.matchAll(/(?:^|\n)```[^\n]*\n([\s\S]*?)(?=\n```|$)/g)];
    const fenced = fences.at(-1)?.[1] || '';
    if (fenced.trim()) return fenced;
    const start = this.buffer.lastIndexOf('<tool_call>');
    if (start < 0) return '';
    const call = this.buffer.slice(start);
    if (!/"name"\s*:\s*"(?:fs_write|fs_edit|MultiEdit|write_file|edit_file|create_file)"/.test(call)) return '';
    const field = /"(?:content|new_string|replaceContent|newText)"\s*:\s*"/.exec(call);
    if (!field || field.index === undefined) return '';
    const raw = call.slice(field.index + field[0].length);
    let escaped = false;
    let end = raw.length;
    for (let i = 0; i < raw.length; i++) {
      if (escaped) { escaped = false; continue; }
      if (raw[i] === '\\') { escaped = true; continue; }
      if (raw[i] === '"') { end = i; break; }
    }
    const partial = raw.slice(0, end).replace(/\\$/u, '');
    try { return JSON.parse(`"${partial}"`); }
    catch { return partial.replace(/\\n/g, '\n'); }
  }
}

/** Observe only a file named by a native edit action. No model calls are made. */
export class NativeCodeObserver {
  private readonly workspaceRoot: string;
  private readonly emit: (event: CodeProgressEvent) => void;
  private active = new Map<string, {
    event: CodeProgressEvent;
    path: string;
    previous: string | null;
    lastShown: string | null;
    timer: NodeJS.Timeout;
  }>();

  constructor(workspaceRoot: string, emit: (event: CodeProgressEvent) => void) {
    this.workspaceRoot = workspaceRoot;
    this.emit = emit;
  }

  handle(event: CodeProgressEvent): void {
    if (!event.path || !['Creating', 'Editing'].includes(event.operation)) return;
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
        this.emit({ ...event, code: current, ...(entry?.previous !== null && entry?.previous !== undefined ? { before: entry.previous } : {}) });
      }
    }
    this.stop(event.id);
  }

  poll(id: string): void {
    const entry = this.active.get(id);
    if (!entry) return;
    const current = this.read(entry.path);
    if (current === null || current === entry.previous || current === entry.lastShown) return;
    entry.lastShown = current;
    this.emit({ ...entry.event, code: current, ...(entry.previous !== null ? { before: entry.previous } : {}) });
  }

  dispose(): void {
    for (const id of this.active.keys()) this.stop(id);
  }

  private stop(id: string): void {
    const entry = this.active.get(id);
    if (entry) clearInterval(entry.timer);
    this.active.delete(id);
  }

  private read(file: string): string | null {
    try {
      const name = path.basename(file).toLowerCase();
      if (/^(\.env(?:\.|$)|.*\.(?:pem|key|p12|pfx)$)/u.test(name)) return null;
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.size > 256_000) return null;
      const bytes = fs.readFileSync(file);
      if (bytes.includes(0)) return null;
      return bytes.toString('utf8');
    } catch {
      return null;
    }
  }
}

type PreviewLine = { kind: 'add' | 'del' | 'ctx'; text: string };

function splitCodeLines(code: string): string[] {
  if (!code) return [];
  const lines = code.replace(/\r\n?/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function previewLines(event: CodeProgressEvent): PreviewLine[] {
  if (event.code === undefined) return [];
  if (event.before !== undefined) {
    const oldLines = splitCodeLines(event.before);
    const newLines = splitCodeLines(event.code);
    let prefix = 0;
    while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
    let suffix = 0;
    while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix
      && oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]) suffix++;
    const changedOld = oldLines.slice(prefix, oldLines.length - suffix);
    const changedNew = newLines.slice(prefix, newLines.length - suffix);
    const result = diffLines(changedOld.join('\n'), changedNew.join('\n'));
    // Diff only the changed middle so a small edit in a long file stays fast.
    // A partial middle diff could mislabel lines, so leave that case neutral.
    if (result.truncated) return newLines.map(text => ({ kind: 'ctx', text }));
    return [
      ...oldLines.slice(0, prefix).map(text => ({ kind: 'ctx' as const, text })),
      ...result.ops,
      ...oldLines.slice(oldLines.length - suffix).map(text => ({ kind: 'ctx' as const, text }))
    ];
  }
  const kind = event.operation === 'Removing' ? 'del'
    : event.operation === 'Creating' || event.operation === 'Drafting' ? 'add' : 'ctx';
  return splitCodeLines(event.code).map(text => ({ kind, text }));
}

export function codePreviewLineCount(event: CodeProgressEvent): number {
  return previewLines(event).length;
}

function highlightCode(kind: PreviewLine['kind'], text: string, width: number): string {
  const marker = kind === 'add' ? '+' : kind === 'del' ? '-' : ' ';
  const role = kind === 'add' ? 'success' : kind === 'del' ? 'danger' : 'muted';
  const body = padEnd(truncate(safeDisplay(text), Math.max(1, width - 2)), Math.max(1, width - 2));
  if (kind === 'ctx' || COLOR_DEPTH < 256) return paint(role, marker) + ' ' + body;
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
export function renderCodeProgress(event: CodeProgressEvent, width: number, modelNote = '', startLine?: number): string[] {
  const safeWidth = Math.max(12, Math.floor(width) || 80);
  const inner = safeWidth - 4;
  const title = `${event.phase === 'done' ? '✓ ' : event.phase === 'failed' ? '× ' : ''}code · ${event.operation.toLowerCase()}`;
  const rows = [truncate(safeDisplay(event.description), inner)];
  if (event.path) rows.push(truncate(safeDisplay(event.path), inner));
  if (modelNote) rows.push(truncate(`model note: ${safeDisplay(modelNote)}`, inner));
  const codeLines = previewLines(event);
  const maxStart = Math.max(0, codeLines.length - CODE_PANEL_LINES);
  const start = startLine === undefined ? maxStart : Math.max(0, Math.min(Math.floor(startLine), maxStart));
  const visible = codeLines.slice(start, start + CODE_PANEL_LINES);
  if (visible.length) {
    rows.push('');
    for (const line of visible) rows.push(highlightCode(line.kind, line.text, inner));
    if (codeLines.length > CODE_PANEL_LINES) {
      rows.push(truncate(`lines ${start + 1}-${start + visible.length} of ${codeLines.length} · scroll over code`, inner));
    }
    if (event.codeTruncated) rows.push(truncate('Earlier draft content exceeded the preview limit', inner));
  }
  return panel(rows, { width: safeWidth, title, role: event.phase === 'failed' ? 'danger' : 'rule' });
}
