/**
 * Causyne Agent — Unified Diff Parser & Interactive Diff Review (Phase B4)
 *
 * Parses Git unified diffs line-by-line (zero catastrophic regexes), produces
 * file/hunk statistics, and formats sanitized terminal-safe diff previews.
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { safeDisplay } from './tui/text.js';
import { resolveGitRepoRoot } from './worktreeManager.js';

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
}

export interface DiffFileSummary {
  oldPath: string;
  newPath: string;
  displayPath: string;
  status: 'modified' | 'added' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

export interface DiffReviewReport {
  repoRoot: string;
  staged: boolean;
  ref: string | null;
  files: DiffFileSummary[];
  totalAdditions: number;
  totalDeletions: number;
  truncated: boolean;
}

const MAX_DIFF_BYTES = 2 * 1024 * 1024;
const MAX_RENDERED_LINES = 600;
const SAFE_REF_RE = /^[a-zA-Z0-9._/@^~:-]{1,128}$/;

function parseHunkHeader(line: string): { oldStart: number; oldCount: number; newStart: number; newCount: number } | null {
  // Format: @@ -12,4 +12,6 @@ optional context
  if (!line.startsWith('@@ -')) return null;
  const closeIdx = line.indexOf(' @@', 4);
  if (closeIdx === -1) return null;
  const body = line.slice(4, closeIdx).trim();
  const spaceIdx = body.indexOf(' +');
  if (spaceIdx === -1) return null;
  const oldPart = body.slice(0, spaceIdx);
  const newPart = body.slice(spaceIdx + 2);
  const parseRange = (part: string): [number, number] | null => {
    const comma = part.indexOf(',');
    if (comma === -1) {
      const start = Number.parseInt(part, 10);
      return Number.isFinite(start) && start >= 0 ? [start, 1] : null;
    }
    const start = Number.parseInt(part.slice(0, comma), 10);
    const count = Number.parseInt(part.slice(comma + 1), 10);
    return Number.isFinite(start) && start >= 0 && Number.isFinite(count) && count >= 0 ? [start, count] : null;
  };
  const oldRange = parseRange(oldPart);
  const newRange = parseRange(newPart);
  if (!oldRange || !newRange) return null;
  return {
    oldStart: oldRange[0],
    oldCount: oldRange[1],
    newStart: newRange[0],
    newCount: newRange[1]
  };
}

function unquoteGitPath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
  return trimmed;
}

function stripDiffPrefix(rawPath: string): string {
  const unquoted = unquoteGitPath(rawPath);
  if (unquoted.startsWith('a/') || unquoted.startsWith('b/')) return unquoted.slice(2);
  return unquoted;
}

function parseDiffGitPaths(rest: string): { oldPath: string; newPath: string } {
  const trimmed = rest.trim();
  if (trimmed.startsWith('"')) {
    // Parse two quoted tokens: "a/old path" "b/new path" (or mixed quoted/unquoted)
    let i = 1;
    while (i < trimmed.length) {
      if (trimmed[i] === '\\') { i += 2; continue; }
      if (trimmed[i] === '"') { i++; break; }
      i++;
    }
    const left = trimmed.slice(0, i);
    const right = trimmed.slice(i).trim();
    return { oldPath: stripDiffPrefix(left), newPath: stripDiffPrefix(right) };
  }
  const quotedBIdx = trimmed.indexOf(' "b/');
  if (quotedBIdx > 0) {
    return {
      oldPath: stripDiffPrefix(trimmed.slice(0, quotedBIdx)),
      newPath: stripDiffPrefix(trimmed.slice(quotedBIdx + 1))
    };
  }
  // Find the split between `a/<path>` and `b/<path>`; prefer last ` b/` when symmetric
  const bIdx = trimmed.lastIndexOf(' b/');
  if (bIdx > 0) {
    return {
      oldPath: stripDiffPrefix(trimmed.slice(0, bIdx)),
      newPath: stripDiffPrefix(trimmed.slice(bIdx + 1))
    };
  }
  return { oldPath: '', newPath: '' };
}

export function parseUnifiedDiff(diffText: string): DiffFileSummary[] {
  const files: DiffFileSummary[] = [];
  if (typeof diffText !== 'string' || !diffText.trim()) return files;

  let current: DiffFileSummary | null = null;
  let currentHunk: DiffHunk | null = null;

  for (const rawLine of diffText.split(/\r?\n/)) {
    if (rawLine.startsWith('diff --git ')) {
      currentHunk = null;
      const rest = rawLine.slice('diff --git '.length);
      const { oldPath, newPath } = parseDiffGitPaths(rest);
      current = {
        oldPath,
        newPath,
        displayPath: newPath || oldPath || '(unknown)',
        status: 'modified',
        additions: 0,
        deletions: 0,
        hunks: []
      };
      files.push(current);
      continue;
    }

    if (!current) continue;

    if (rawLine.startsWith('new file mode ')) {
      current.status = 'added';
      continue;
    }
    if (rawLine.startsWith('deleted file mode ')) {
      current.status = 'deleted';
      continue;
    }
    if (rawLine.startsWith('rename from ')) {
      current.status = 'renamed';
      current.oldPath = rawLine.slice('rename from '.length).trim();
      continue;
    }
    if (rawLine.startsWith('rename to ')) {
      current.status = 'renamed';
      current.newPath = rawLine.slice('rename to '.length).trim();
      current.displayPath = current.newPath || current.displayPath;
      continue;
    }
    if (rawLine.startsWith('--- ')) {
      const p = rawLine.slice(4).trim();
      if (p !== '/dev/null') current.oldPath = stripDiffPrefix(p);
      continue;
    }
    if (rawLine.startsWith('+++ ')) {
      const p = rawLine.slice(4).trim();
      if (p !== '/dev/null') {
        current.newPath = stripDiffPrefix(p);
        current.displayPath = current.newPath;
      }
      continue;
    }

    const parsedHunk = parseHunkHeader(rawLine);
    if (parsedHunk) {
      currentHunk = {
        header: rawLine,
        ...parsedHunk,
        lines: []
      };
      current.hunks.push(currentHunk);
      continue;
    }

    if (currentHunk) {
      currentHunk.lines.push(rawLine);
      if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) {
        current.additions++;
      } else if (rawLine.startsWith('-') && !rawLine.startsWith('---')) {
        current.deletions++;
      }
    }
  }

  return files;
}

export function collectWorkingTreeDiff(
  workspaceDir: string,
  options: {
    staged?: boolean | undefined;
    ref?: string | undefined;
    filePath?: string | undefined;
  } = {}
): DiffReviewReport {
  const repoRoot = resolveGitRepoRoot(workspaceDir);
  if (!repoRoot) {
    throw new Error('Current workspace is not inside a Git repository.');
  }

  const args = ['diff', '--no-color', '--unified=3'];
  if (options.staged) {
    args.push('--cached');
  } else if (typeof options.ref === 'string' && options.ref.trim()) {
    const cleanRef = options.ref.trim();
    if (cleanRef.startsWith('-') || !SAFE_REF_RE.test(cleanRef)) {
      throw new Error(`Invalid git ref "${safeDisplay(cleanRef)}".`);
    }
    args.push(cleanRef);
  }

  if (typeof options.filePath === 'string' && options.filePath.trim()) {
    const rawTarget = options.filePath.trim();
    if (rawTarget.includes('\0') || rawTarget.startsWith('-')) {
      throw new Error(`Invalid diff path filter "${safeDisplay(rawTarget)}".`);
    }
    const resolved = path.isAbsolute(rawTarget) ? path.resolve(rawTarget) : path.resolve(repoRoot, rawTarget);
    const rel = path.relative(repoRoot, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`Diff file filter escapes repository root: ${safeDisplay(rawTarget)}`);
    }
    args.push('--', rel || '.');
  }

  const rawDiff = execFileSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: MAX_DIFF_BYTES,
    timeout: 20_000,
    windowsHide: true
  });

  const truncated = Buffer.byteLength(rawDiff, 'utf8') >= MAX_DIFF_BYTES - 1024;
  const files = parseUnifiedDiff(rawDiff);

  // Also include untracked non-ignored working-tree files so newly created files appear in /diff
  if (!options.staged && !options.ref) {
    try {
      const lsArgs = ['ls-files', '--others', '--exclude-standard', '-z'];
      if (typeof options.filePath === 'string' && options.filePath.trim()) {
        const rawTarget = options.filePath.trim();
        const resolved = path.isAbsolute(rawTarget) ? path.resolve(rawTarget) : path.resolve(repoRoot, rawTarget);
        const rel = path.relative(repoRoot, resolved);
        if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
          lsArgs.push('--', rel);
        }
      }
      const untrackedRaw = execFileSync('git', lsArgs, {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 2 * 1024 * 1024,
        timeout: 10_000,
        windowsHide: true
      });
      const existing = new Set(files.map((f) => f.displayPath));
      const untracked = untrackedRaw.split('\0').filter(Boolean).slice(0, 30);
      for (const relPath of untracked) {
        if (existing.has(relPath)) continue;
        const absPath = path.join(repoRoot, relPath);
        try {
          const stat = fs.lstatSync(absPath);
          if (stat.isSymbolicLink() || !stat.isFile() || stat.size > 64 * 1024) continue;
          const buf = fs.readFileSync(absPath);
          if (buf.includes(0)) {
            files.push({
              oldPath: relPath,
              newPath: relPath,
              displayPath: relPath,
              status: 'added',
              additions: 0,
              deletions: 0,
              hunks: []
            });
            continue;
          }
          const contentLines = buf.toString('utf8').split(/\r?\n/);
          if (contentLines.length > 0 && contentLines[contentLines.length - 1] === '') {
            contentLines.pop();
          }
          files.push({
            oldPath: relPath,
            newPath: relPath,
            displayPath: relPath,
            status: 'added',
            additions: contentLines.length,
            deletions: 0,
            hunks: contentLines.length > 0 ? [{
              header: `@@ -0,0 +1,${contentLines.length} @@`,
              oldStart: 0,
              oldCount: 0,
              newStart: 1,
              newCount: contentLines.length,
              lines: contentLines.map((line) => `+${line}`)
            }] : []
          });
        } catch { /* skip unreadable untracked file */ }
      }
    } catch { /* best-effort untracked discovery */ }
  }

  let totalAdditions = 0;
  let totalDeletions = 0;
  for (const f of files) {
    totalAdditions += f.additions;
    totalDeletions += f.deletions;
  }

  return {
    repoRoot,
    staged: Boolean(options.staged),
    ref: options.ref?.trim() || null,
    files,
    totalAdditions,
    totalDeletions,
    truncated
  };
}

export function renderDiffReview(
  report: DiffReviewReport,
  options: { statOnly?: boolean | undefined; maxLines?: number | undefined } = {}
): string {
  if (report.files.length === 0) {
    const scope = report.staged ? 'staged' : (report.ref ? `against ${safeDisplay(report.ref)}` : 'working tree');
    return `No ${scope} changes found.`;
  }

  const maxLines = Math.max(20, Math.min(MAX_RENDERED_LINES, options.maxLines ?? 240));
  const titleScope = report.staged ? 'Staged Diff' : (report.ref ? `Diff vs ${safeDisplay(report.ref)}` : 'Working Tree Diff');
  const lines: string[] = [
    `${titleScope} (${report.files.length} file(s), +${report.totalAdditions} / -${report.totalDeletions})`,
    ''
  ];

  for (const file of report.files) {
    const tag = file.status === 'added' ? 'A'
      : file.status === 'deleted' ? 'D'
        : file.status === 'renamed' ? 'R'
          : 'M';
    lines.push(`  [${tag}] ${safeDisplay(file.displayPath)}  (+${file.additions} / -${file.deletions}, ${file.hunks.length} hunk(s))`);
  }

  if (options.statOnly) {
    return lines.join('\n');
  }

  lines.push('');
  let emitted = 0;
  let clipped = false;
  for (const file of report.files) {
    if (emitted >= maxLines) { clipped = true; break; }
    lines.push(`--- ${safeDisplay(file.displayPath)} (${file.status}) ---`);
    emitted++;
    for (const hunk of file.hunks) {
      if (emitted >= maxLines) { clipped = true; break; }
      lines.push(safeDisplay(hunk.header));
      emitted++;
      for (const hLine of hunk.lines) {
        if (emitted >= maxLines) { clipped = true; break; }
        lines.push(safeDisplay(hLine));
        emitted++;
      }
    }
  }
  if (clipped || report.truncated) {
    lines.push('');
    lines.push('... [diff output truncated; filter with `/diff <file>` or `/diff --stat`]');
  }
  return lines.join('\n');
}
