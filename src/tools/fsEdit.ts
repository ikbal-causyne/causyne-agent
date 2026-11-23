import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteFileSync } from '../infra/atomicWriter.js';
import { collectActivePostEditDiagnostics, formatDiagnosticsCompact } from '../lsp/lspClient.js';
import { checkFileStaleness, recordFileObserved } from './fileTracker.js';

export interface FsEditItem {
  searchContent: string;
  replaceContent: string;
  replace_all?: boolean | undefined;
  replaceAll?: boolean | undefined;
}

export interface FsEditArgs {
  path: string;
  edits: FsEditItem[];
  replace_all?: boolean | undefined;
  replaceAll?: boolean | undefined;
}

export interface FsEditResult {
  success: boolean;
  output?: string;
  error?: string;
}

export interface FsEditContext {
  workspaceRoot?: string;
  workspacePaths?: string[];
  grantAllAccess?: boolean;
  parentLoop?: { workspaceRoot?: string };
}

function expandHome(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '~') return os.homedir();
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(os.homedir(), trimmed.slice(2));
  }
  return trimmed;
}

function insideRoot(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

async function assertWithinEditScope(target: string, context?: FsEditContext): Promise<void> {
  if (!context || context.grantAllAccess === true) return;
  const configured = Array.isArray(context.workspacePaths)
    ? context.workspacePaths.filter((p): p is string => typeof p === 'string' && p.trim().length > 0).map(p => p.trim())
    : [];
  const roots = configured.length > 0
    ? configured
    : [context.parentLoop?.workspaceRoot, context.workspaceRoot]
      .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
      .map(p => p.trim());
  if (roots.length === 0) return;
  const realTarget = await fs.realpath(target);
  for (const root of roots) {
    try {
      const realRoot = await fs.realpath(path.resolve(expandHome(root)));
      if (insideRoot(realRoot, realTarget)) return;
    } catch {
      continue;
    }
  }
  throw new Error(`Target resolves outside the selected workspace: ${target}`);
}

function findExactOffsets(haystack: string, needle: string): number[] {
  const offsets: number[] = [];
  if (!needle) return offsets;
  let pos = 0;
  while (pos <= haystack.length - needle.length) {
    const idx = haystack.indexOf(needle, pos);
    if (idx === -1) break;
    offsets.push(idx);
    pos = idx + needle.length;
  }
  return offsets;
}

function lineNumberAtOffset(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) line++;
  }
  return line;
}

function closestLineHint(text: string, needle: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const firstNonEmpty = needle.replace(/\r\n/g, '\n').split('\n').find((l) => l.trim().length > 0)?.trim() ?? '';
  if (!firstNonEmpty || lines.length === 0) return '';
  const probeTokens = new Set(firstNonEmpty.toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length >= 2));
  let bestLine = -1;
  let bestScore = 0;
  for (let i = 0; i < lines.length; i++) {
    const candidate = lines[i]!.trim();
    if (!candidate) continue;
    let score = 0;
    if (candidate.toLowerCase().includes(firstNonEmpty.toLowerCase()) || firstNonEmpty.toLowerCase().includes(candidate.toLowerCase())) {
      score += 5;
    }
    if (probeTokens.size > 0) {
      for (const tok of candidate.toLowerCase().split(/[^a-z0-9_]+/)) {
        if (probeTokens.has(tok)) score++;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestLine = i;
    }
  }
  if (bestLine === -1 || bestScore === 0) return '';
  return ` Closest line ${bestLine + 1}: ${JSON.stringify(lines[bestLine]!.slice(0, 140))}`;
}

function reindentReplacement(
  matchedLines: readonly string[],
  searchLines: readonly string[],
  replaceLines: readonly string[]
): string[] {
  const firstNonEmptyIdx = searchLines.findIndex((l) => l.trim().length > 0);
  if (firstNonEmptyIdx === -1 || firstNonEmptyIdx >= matchedLines.length) return [...replaceLines];
  const fileIndent = (matchedLines[firstNonEmptyIdx]!.match(/^[ \t]*/) ?? [''])[0];
  const searchIndent = (searchLines[firstNonEmptyIdx]!.match(/^[ \t]*/) ?? [''])[0];
  if (fileIndent === searchIndent) return [...replaceLines];
  return replaceLines.map((line) => {
    if (!line.trim()) return '';
    if (searchIndent && line.startsWith(searchIndent)) {
      return `${fileIndent}${line.slice(searchIndent.length)}`;
    }
    return `${fileIndent}${line.trimStart()}`;
  });
}

export function applyDeterministicEdit(
  content: string,
  search: string,
  replace: string,
  replaceAll: boolean,
  editIndex: number
): { ok: true; nextContent: string; count: number } | { ok: false; error: string } {
  const fileEol = content.includes('\r\n') ? '\r\n' : '\n';

  // Tier 1: Exact literal match
  const exactOffsets = findExactOffsets(content, search);
  if (exactOffsets.length === 1) {
    const idx = exactOffsets[0]!;
    return {
      ok: true,
      nextContent: content.slice(0, idx) + replace + content.slice(idx + search.length),
      count: 1
    };
  }
  if (exactOffsets.length > 1) {
    if (replaceAll) {
      return {
        ok: true,
        nextContent: content.split(search).join(replace),
        count: exactOffsets.length
      };
    }
    const lines = exactOffsets.slice(0, 6).map((off) => lineNumberAtOffset(content, off));
    return {
      ok: false,
      error: `ATOMIC ROLLBACK: Edit index ${editIndex} is ambiguous — matched ${exactOffsets.length} locations (lines ${lines.join(', ')}). Include more surrounding context or pass replace_all: true.`
    };
  }

  // Tier 2: Line-ending normalized match (preserves file CRLF vs LF)
  const normContent = content.replace(/\r\n/g, '\n');
  const normSearch = search.replace(/\r\n/g, '\n');
  const normReplace = replace.replace(/\r\n/g, '\n');
  const eolOffsets = findExactOffsets(normContent, normSearch);
  if (eolOffsets.length === 1) {
    const idx = eolOffsets[0]!;
    const updated = normContent.slice(0, idx) + normReplace + normContent.slice(idx + normSearch.length);
    return {
      ok: true,
      nextContent: fileEol === '\r\n' ? updated.replace(/\n/g, '\r\n') : updated,
      count: 1
    };
  }
  if (eolOffsets.length > 1) {
    if (replaceAll) {
      const updated = normContent.split(normSearch).join(normReplace);
      return {
        ok: true,
        nextContent: fileEol === '\r\n' ? updated.replace(/\n/g, '\r\n') : updated,
        count: eolOffsets.length
      };
    }
    const lines = eolOffsets.slice(0, 6).map((off) => lineNumberAtOffset(normContent, off));
    return {
      ok: false,
      error: `ATOMIC ROLLBACK: Edit index ${editIndex} is ambiguous — matched ${eolOffsets.length} locations (lines ${lines.join(', ')}). Include more surrounding context or pass replace_all: true.`
    };
  }

  // Tier 3: Deterministic trimmed-line whitespace/indent-preserving match (never silently alters code tokens)
  const fileLines = normContent.split('\n');
  const searchLines = normSearch.split('\n');
  const replaceLines = normReplace.split('\n');
  const hasContentLine = searchLines.some((l) => l.trim().length > 0);
  if (hasContentLine && searchLines.length <= fileLines.length) {
    const lineMatches: number[] = [];
    for (let j = 0; j <= fileLines.length - searchLines.length; j++) {
      let allTrimEqual = true;
      for (let k = 0; k < searchLines.length; k++) {
        if (fileLines[j + k]!.trim() !== searchLines[k]!.trim()) {
          allTrimEqual = false;
          break;
        }
      }
      if (allTrimEqual) lineMatches.push(j);
    }
    if (lineMatches.length === 1) {
      const pos = lineMatches[0]!;
      const reindented = reindentReplacement(fileLines.slice(pos, pos + searchLines.length), searchLines, replaceLines);
      fileLines.splice(pos, searchLines.length, ...reindented);
      const updated = fileLines.join(fileEol);
      return { ok: true, nextContent: updated, count: 1 };
    }
    if (lineMatches.length > 1) {
      if (replaceAll) {
        // Apply from bottom to top so earlier line indices remain valid
        for (let m = lineMatches.length - 1; m >= 0; m--) {
          const pos = lineMatches[m]!;
          const reindented = reindentReplacement(fileLines.slice(pos, pos + searchLines.length), searchLines, replaceLines);
          fileLines.splice(pos, searchLines.length, ...reindented);
        }
        return { ok: true, nextContent: fileLines.join(fileEol), count: lineMatches.length };
      }
      const lineNums = lineMatches.slice(0, 6).map((idx) => idx + 1);
      return {
        ok: false,
        error: `ATOMIC ROLLBACK: Edit index ${editIndex} is ambiguous across whitespace-trimmed lines (${lineMatches.length} matches at lines ${lineNums.join(', ')}). Include more context or pass replace_all: true.`
      };
    }
  }

  const hint = closestLineHint(normContent, normSearch);
  return {
    ok: false,
    error: `ATOMIC ROLLBACK: Edit index ${editIndex} failed — exact/whitespace-normalized match not found.${hint} Previous edits in this batch were rolled back.`
  };
}

export const fsEdit = {
  schema: {
    name: 'fs.edit',
    description: 'Surgically edit specific lines/blocks in a file atomically with exact, EOL-preserving, and whitespace/indent-preserving unique matching. Rejects ambiguous matches unless replace_all is true.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        replace_all: { type: 'boolean', description: 'When true, replace all matching occurrences instead of requiring a unique match.' },
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              searchContent: { type: 'string' },
              replaceContent: { type: 'string' },
              replace_all: { type: 'boolean' }
            },
            required: ['searchContent', 'replaceContent']
          }
        }
      },
      required: ['path', 'edits']
    }
  },

  async execute(args: FsEditArgs, context?: FsEditContext): Promise<FsEditResult> {
    try {
      if (!args || typeof args !== 'object') {
        return { success: false, error: 'fs_edit requires an object with path and edits array.' };
      }
      if (typeof args.path !== 'string' || !args.path.trim()) {
        return { success: false, error: 'fs_edit requires a non-empty string path.' };
      }
      if (!Array.isArray(args.edits) || args.edits.length === 0) {
        return { success: false, error: 'fs_edit requires a non-empty edits array.' };
      }

      const expandedPath = expandHome(args.path);
      const baseRoot = context?.parentLoop?.workspaceRoot?.trim()
        || context?.workspaceRoot?.trim()
        || context?.workspacePaths?.find((p): p is string => typeof p === 'string' && p.trim().length > 0)?.trim();
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
      await assertWithinEditScope(target, context);
      const staleness = checkFileStaleness(target, stat);
      if (staleness.stale && (context as { strictFreshness?: boolean } | undefined)?.strictFreshness === true) {
        return { success: false, error: staleness.warning || `File modified externally: ${args.path}` };
      }
      const originalMode = stat.mode & 0o777;
      const originalContent = await fs.readFile(target, 'utf8');
      let workingContent = originalContent;
      let replacements = 0;

      for (let i = 0; i < args.edits.length; i++) {
        const edit = args.edits[i];
        if (!edit || typeof edit.searchContent !== 'string' || edit.searchContent.length === 0 || typeof edit.replaceContent !== 'string') {
          return {
            success: false,
            error: `ATOMIC ROLLBACK: Edit index ${i} is missing valid non-empty searchContent or replaceContent strings. Rollback complete.`
          };
        }

        const replaceAll = edit.replace_all === true || edit.replaceAll === true || args.replace_all === true || args.replaceAll === true;
        const applied = applyDeterministicEdit(workingContent, edit.searchContent, edit.replaceContent, replaceAll, i);
        if (!applied.ok) {
          return { success: false, error: applied.error };
        }
        workingContent = applied.nextContent;
        replacements += applied.count;
      }

      // Commit the transaction atomically, preserving original file permissions
      atomicWriteFileSync(target, workingContent, { encoding: 'utf8', mode: originalMode });
      recordFileObserved(target);
      const wsRoot = baseRoot ? path.resolve(expandHome(baseRoot)) : path.dirname(target);
      const diags = await collectActivePostEditDiagnostics(target, wsRoot, workingContent);
      const diagNote = diags.length > 0 ? `\n\n[LSP Diagnostics]\n${formatDiagnosticsCompact(diags, wsRoot)}` : '';
      const staleNote = staleness.stale && staleness.warning ? `\n[Notice: ${staleness.warning}]` : '';
      return { success: true, output: `Transaction Success: ${replacements} replacement(s) safely applied to ${args.path}${staleNote}${diagNote}` };
    } catch (e: unknown) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
};
