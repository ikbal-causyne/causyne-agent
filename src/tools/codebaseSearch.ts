import fs from 'node:fs/promises';
import path from 'node:path';
import {
  MAX_FILE_BYTES,
  checkSearchScope,
  compileSafeSearchRegex,
  createTraversalGuard,
  isSafeSymlinkTarget,
  looksBinaryFile,
  resolveSearchRoot,
  shouldExcludeChild,
  type SearchExecutionContext,
  type TraversalGuard
} from './walkerSafety.js';

const MAX_MATCHES = 50;

export interface CodebaseSearchArgs {
  query: string;
  target_directories?: string[] | undefined;
  isRegex?: boolean | undefined;
}

export interface CodebaseSearchResult {
  success: boolean;
  output?: string;
  error?: string;
  aborted?: boolean;
}

async function* walkBounded(
  dir: string,
  rootReal: string,
  seen: Set<string>,
  guard: TraversalGuard,
  depth: number,
  context?: SearchExecutionContext
): AsyncGenerator<string> {
  if (!guard.enterDir(depth)) return;

  let real: string;
  try {
    real = await fs.realpath(dir);
  } catch {
    return;
  }
  if (!isSafeSymlinkTarget(real, rootReal, context)) return;
  if (seen.has(real)) return;
  seen.add(real);

  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (guard.checkStopped()) return;
    if (shouldExcludeChild(real, entry.name)) continue;
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      yield* walkBounded(full, rootReal, seen, guard, depth + 1, context);
    } else if (entry.isFile()) {
      yield full;
    } else if (entry.isSymbolicLink()) {
      try {
        const targetReal = await fs.realpath(full);
        if (!isSafeSymlinkTarget(targetReal, rootReal, context)) continue;
        const stat = await fs.stat(targetReal);
        if (stat.isDirectory()) {
          yield* walkBounded(targetReal, rootReal, seen, guard, depth + 1, context);
        } else if (stat.isFile()) {
          yield full;
        }
      } catch {
        // Ignore broken symlinks.
      }
    }
  }
}

export const codebaseSearch = {
  schema: {
    name: 'codebase_search',
    description:
      'Find snippets of code safely across target workspace directories with bounded traversal and literal matching by default.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'The search query to find relevant code.' },
        target_directories: {
          type: 'array',
          items: { type: 'string' },
          description: 'Directories or files to search'
        },
        isRegex: {
          type: 'boolean',
          description: 'Optional. Treat query as a regular expression (defaults to literal case-insensitive search).'
        }
      },
      required: ['query'],
      additionalProperties: false
    }
  },

  async execute(
    args: CodebaseSearchArgs,
    context?: SearchExecutionContext
  ): Promise<CodebaseSearchResult> {
    try {
      if (!args || typeof args.query !== 'string' || args.query.length === 0) {
        return { success: false, error: 'Missing required "query" argument.' };
      }

      const compiled = compileSafeSearchRegex(args.query, {
        isRegex: args.isRegex === true,
        caseInsensitive: true
      });
      if (!compiled.regex) {
        return { success: false, error: compiled.error || 'Invalid query pattern.' };
      }
      const regex = compiled.regex;

      const dirs =
        Array.isArray(args.target_directories) && args.target_directories.length > 0
          ? args.target_directories
          : ['.'];

      const scopedRoots: Array<{ requested: string; realPath: string }> = [];
      for (const dir of dirs) {
        if (typeof dir !== 'string' || !dir.trim()) continue;
        const candidate = resolveSearchRoot(dir, context);
        const scope = checkSearchScope(candidate, context);
        if (!scope.allowed || !scope.realPath) {
          return {
            success: false,
            error: scope.error || `Target directory not allowed: ${dir}`
          };
        }
        scopedRoots.push({ requested: candidate, realPath: scope.realPath });
      }

      if (scopedRoots.length === 0) {
        const fallback = resolveSearchRoot('.', context);
        const scope = checkSearchScope(fallback, context);
        if (!scope.allowed || !scope.realPath) {
          return { success: false, error: scope.error || `Target directory not allowed: ${fallback}` };
        }
        scopedRoots.push({ requested: fallback, realPath: scope.realPath });
      }

      const guard = createTraversalGuard({ signal: context?.signal });
      const results: string[] = [];

      const scanFile = async (file: string): Promise<void> => {
        if (!guard.countFile()) return;
        let stat;
        try {
          stat = await fs.stat(file);
        } catch {
          return;
        }
        if (stat.size > MAX_FILE_BYTES) return;
        if (await looksBinaryFile(file)) return;

        let content: string;
        try {
          content = await fs.readFile(file, 'utf8');
        } catch {
          return;
        }

        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (guard.checkStopped()) break;
          const line = lines[i]!;
          if (regex.test(line)) {
            results.push(`${file}:${i + 1}:${line.trim().slice(0, 300)}`);
            if (results.length >= MAX_MATCHES) break;
          }
        }
      };

      for (const root of scopedRoots) {
        if (results.length >= MAX_MATCHES || guard.checkStopped()) break;
        let stat;
        try {
          stat = await fs.stat(root.realPath);
        } catch {
          continue;
        }
        if (stat.isFile()) {
          await scanFile(root.realPath);
          continue;
        }
        const seen = new Set<string>();
        for await (const file of walkBounded(root.realPath, root.realPath, seen, guard, 0, context)) {
          if (results.length >= MAX_MATCHES || guard.checkStopped()) break;
          await scanFile(file);
        }
      }

      if (guard.stopReason === 'aborted') {
        return { success: false, aborted: true, error: 'Codebase search aborted.' };
      }

      const stopSuffix = guard.stopReason ? `\n\n[${guard.stopNotice()}]` : '';
      return {
        success: true,
        output:
          results.length > 0
            ? results.join('\n') + stopSuffix
            : `No results found.${guard.stopReason ? ` (${guard.stopNotice()})` : ''}`
      };
    } catch (error: unknown) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
};
