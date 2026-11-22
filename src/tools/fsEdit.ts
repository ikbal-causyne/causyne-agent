import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteFileSync } from '../infra/atomicWriter.js';
import { collectActivePostEditDiagnostics, formatDiagnosticsCompact } from '../lsp/lspClient.js';

export interface FsEditItem {
  searchContent: string;
  replaceContent: string;
}

export interface FsEditArgs {
  path: string;
  edits: FsEditItem[];
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

const MAX_FUZZY_CHARS = 8_192;

function getLevenshteinDistance(a: string, b: string): number {
  let s1 = a;
  let s2 = b;
  if (s1.length > s2.length) {
    const tmp = s1;
    s1 = s2;
    s2 = tmp;
  }
  const m = s1.length;
  const n = s2.length;
  if (m === 0) return n;
  let prev = new Int32Array(m + 1);
  let curr = new Int32Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;

  for (let i = 1; i <= n; i++) {
    curr[0] = i;
    const ch2 = s2.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      const cost = s1.charCodeAt(j - 1) === ch2 ? 0 : 1;
      const del = prev[j]! + 1;
      const ins = curr[j - 1]! + 1;
      const sub = prev[j - 1]! + cost;
      curr[j] = del < ins ? (del < sub ? del : sub) : (ins < sub ? ins : sub);
    }
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[m]!;
}

function calculateConfidence(original: string, match: string): number {
  const maxLen = Math.max(original.length, match.length);
  if (maxLen === 0) return 100;
  if (maxLen > MAX_FUZZY_CHARS) return 0;
  // Impossible to reach 90% confidence when length difference alone exceeds 10%
  if (Math.abs(original.length - match.length) / maxLen > 0.1) return 0;
  const dist = getLevenshteinDistance(original, match);
  return ((maxLen - dist) / maxLen) * 100;
}

export const fsEdit = {
  schema: {
    name: 'fs.edit',
    description: 'Surgically edit specific lines/blocks in a file. Employs 90% confidence Levenshtein fuzzy matching if exact match fails.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        edits: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              searchContent: { type: 'string' },
              replaceContent: { type: 'string' }
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

        // Try exact match first
        if (workingContent.includes(edit.searchContent)) {
          workingContent = workingContent.replace(edit.searchContent, () => edit.replaceContent);
          replacements++;
          continue;
        }

        // Fuzzy Match Fallback
        const lines = workingContent.split('\n');
        const oldLines = edit.searchContent.split('\n');
        let bestIndex = -1;
        let highestConfidence = 0;

        for (let j = 0; j <= lines.length - oldLines.length; j++) {
          const chunk = lines.slice(j, j + oldLines.length).join('\n');
          const conf = calculateConfidence(edit.searchContent, chunk);
          if (conf > highestConfidence) {
            highestConfidence = conf;
            bestIndex = j;
          }
        }

        if (highestConfidence >= 90 && bestIndex !== -1) {
          lines.splice(bestIndex, oldLines.length, edit.replaceContent);
          workingContent = lines.join('\n');
          replacements++;
        } else {
          return {
            success: false,
            error: `ATOMIC ROLLBACK: Edit index ${i} failed. Exact match not found, and fuzzy match confidence was too low (${highestConfidence.toFixed(2)}% < 90%). Previous edits in this batch were rolled back.`
          };
        }
      }

      // Commit the transaction atomically, preserving original file permissions
      atomicWriteFileSync(target, workingContent, { encoding: 'utf8', mode: originalMode });
      const wsRoot = baseRoot ? path.resolve(expandHome(baseRoot)) : path.dirname(target);
      const diags = await collectActivePostEditDiagnostics(target, wsRoot, workingContent);
      const diagNote = diags.length > 0 ? `\n\n[LSP Diagnostics]\n${formatDiagnosticsCompact(diags, wsRoot)}` : '';
      return { success: true, output: `Transaction Success: ${replacements} replacement(s) safely applied to ${args.path}${diagNote}` };
    } catch (e: unknown) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
};
