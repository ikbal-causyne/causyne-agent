import fs from 'node:fs/promises';
import path from 'node:path';
import {
  checkSearchScope,
  createTraversalGuard,
  isSafeSymlinkTarget,
  resolveSearchRoot,
  shouldExcludeChild,
  type SearchExecutionContext
} from './walkerSafety.js';

const MAX_MATCHES = 50;
const MAX_FUZZY_LENGTH = 128;

export interface FsFindArgs {
  path?: string | undefined;
  keywords?: string[] | undefined;
  extensions?: string[] | undefined;
  fuzzyMatch?: boolean | undefined;
  maxDepth?: number | undefined;
}

export interface FsFindResult {
  success: boolean;
  output?: string;
  error?: string;
  aborted?: boolean;
}

function levenshteinDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;

  let prev = new Uint16Array(m + 1);
  let curr = new Uint16Array(m + 1);
  for (let j = 0; j <= m; j++) {
    prev[j] = j;
  }
  for (let i = 1; i <= n; i++) {
    curr[0] = i;
    const bi = b.charCodeAt(i - 1);
    for (let j = 1; j <= m; j++) {
      const cost = a.charCodeAt(j - 1) === bi ? 0 : 1;
      const del = prev[j]! + 1;
      const ins = curr[j - 1]! + 1;
      const sub = prev[j - 1]! + cost;
      curr[j] = Math.min(del, ins, sub);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[m]!;
}

function isMatch(
  filename: string,
  keywords: readonly string[],
  extensions: readonly string[],
  fuzzyMatch: boolean
): boolean {
  const lowerFilename = filename.toLowerCase();

  if (extensions.length > 0) {
    const extMatch = extensions.some((ext) => lowerFilename.endsWith(String(ext).toLowerCase()));
    if (!extMatch) return false;
  }

  if (keywords.length === 0) return true;

  for (const kw of keywords) {
    const lowerKw = String(kw).toLowerCase();
    if (!lowerKw) continue;
    if (lowerFilename.includes(lowerKw)) return true;

    if (
      fuzzyMatch &&
      lowerKw.length >= 4 &&
      lowerKw.length <= MAX_FUZZY_LENGTH &&
      lowerFilename.length <= MAX_FUZZY_LENGTH
    ) {
      const maxDistance = Math.floor(lowerKw.length / 4);
      const winLen = lowerKw.length + 1;
      for (let i = 0; i <= lowerFilename.length - lowerKw.length + 1; i++) {
        const chunk = lowerFilename.slice(i, i + winLen);
        if (levenshteinDistance(chunk, lowerKw) <= maxDistance) return true;
      }
    }
  }
  return false;
}

export const fsFind = {
  schema: {
    name: 'fs.find',
    description:
      'Fast file search by filename keywords and extensions with optional typo tolerance and bounded traversal.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Root directory to start the search. Defaults to workspace root.' },
        keywords: { type: 'array', items: { type: 'string' } },
        extensions: { type: 'array', items: { type: 'string' } },
        fuzzyMatch: { type: 'boolean', description: 'Set to true to enable typo tolerance.' }
      }
    }
  },

  async execute(
    args: FsFindArgs = {},
    context?: SearchExecutionContext
  ): Promise<FsFindResult> {
    try {
      const targetDir = resolveSearchRoot(args?.path, context);
      const scope = checkSearchScope(targetDir, context);
      if (!scope.allowed || !scope.realPath) {
        return { success: false, error: scope.error || `Search path not allowed: ${targetDir}` };
      }
      const rootReal = scope.realPath;

      let stat;
      try {
        stat = await fs.stat(rootReal);
      } catch {
        return { success: false, error: `Search directory does not exist: ${targetDir}` };
      }
      if (!stat.isDirectory()) {
        return { success: false, error: `Search path is not a directory: ${targetDir}` };
      }

      const keywords = Array.isArray(args?.keywords) ? args.keywords : [];
      const extensions = Array.isArray(args?.extensions) ? args.extensions : [];
      const fuzzyMatch = args?.fuzzyMatch === true;
      const maxDepth =
        typeof args?.maxDepth === 'number' && Number.isInteger(args.maxDepth) && args.maxDepth > 0
          ? Math.min(args.maxDepth, 24)
          : undefined;

      const guard = createTraversalGuard({ maxFiles: 30_000, maxDepth, signal: context?.signal });
      const seen = new Set<string>();
      const matches: string[] = [];
      let scanned = 0;

      const queue: Array<{ dir: string; real: string; depth: number }> = [
        { dir: rootReal, real: rootReal, depth: 0 }
      ];

      while (queue.length > 0 && matches.length < MAX_MATCHES) {
        if (guard.checkStopped()) break;
        const current = queue.shift()!;
        if (seen.has(current.real)) continue;
        if (!guard.enterDir(current.depth)) continue;
        seen.add(current.real);

        let dirents;
        try {
          dirents = await fs.readdir(current.dir, { withFileTypes: true });
        } catch {
          continue;
        }

        for (const dirent of dirents) {
          if (matches.length >= MAX_MATCHES || guard.checkStopped()) break;
          if (shouldExcludeChild(current.real, dirent.name)) continue;
          const full = path.join(current.dir, dirent.name);

          if (dirent.isDirectory()) {
            try {
              const childReal = await fs.realpath(full);
              if (isSafeSymlinkTarget(childReal, rootReal, context) && !seen.has(childReal)) {
                queue.push({ dir: full, real: childReal, depth: current.depth + 1 });
              }
            } catch {
              // Ignore unreadable directories.
            }
          } else if (dirent.isFile()) {
            if (!guard.countFile()) break;
            scanned++;
            if (isMatch(dirent.name, keywords, extensions, fuzzyMatch)) {
              matches.push(full);
            }
          } else if (dirent.isSymbolicLink()) {
            try {
              const targetReal = await fs.realpath(full);
              if (!isSafeSymlinkTarget(targetReal, rootReal, context)) continue;
              const targetStat = await fs.stat(targetReal);
              if (targetStat.isDirectory()) {
                if (!seen.has(targetReal)) {
                  queue.push({ dir: targetReal, real: targetReal, depth: current.depth + 1 });
                }
              } else if (targetStat.isFile()) {
                if (!guard.countFile()) break;
                scanned++;
                if (isMatch(dirent.name, keywords, extensions, fuzzyMatch)) {
                  matches.push(full);
                }
              }
            } catch {
              // Ignore broken symlinks.
            }
          }
        }
      }

      if (guard.stopReason === 'aborted') {
        return { success: false, aborted: true, error: 'File find aborted.' };
      }

      return {
        success: true,
        output: JSON.stringify(
          {
            scanned_files: scanned,
            total_matches: matches.length,
            ...(guard.stopReason ? { stopped_reason: guard.stopNotice() } : {}),
            matches: matches.length > 0 ? matches : 'No files matched your search parameters.'
          },
          null,
          2
        )
      };
    } catch (error: unknown) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
};
