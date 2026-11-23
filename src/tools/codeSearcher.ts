import { execFile } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { loadWorkspaceIgnoreMatcher } from '../ignoreRules.js';
import {
  DEFAULT_TIMEOUT_MS,
  MAX_FILE_BYTES,
  buildHomeGlobExcludes,
  buildTopLevelHomeExcludes,
  checkSearchScope,
  compileSafeSearchRegex,
  createTraversalGuard,
  isSafeSymlinkTarget,
  looksBinaryFile,
  resolveSearchRoot,
  shouldExcludeChild,
  validateRegexSafety,
  type SearchExecutionContext
} from './walkerSafety.js';

const execFileAsync = promisify(execFile);
const MAX_MATCHES = 100;
const RG_MAX_PER_FILE = 50;

export type CodeSearchOutputMode = 'content' | 'files_with_matches' | 'count';

export interface CodeSearchArgs {
  query: string;
  searchPath?: string | undefined;
  isRegex?: boolean | undefined;
  caseInsensitive?: boolean | undefined;
  filePattern?: string | undefined;
  astMode?: boolean | undefined;
  context?: number | undefined;
  contextBefore?: number | undefined;
  contextAfter?: number | undefined;
  outputMode?: CodeSearchOutputMode | undefined;
  multiline?: boolean | undefined;
}

export interface CodeSearchMatch {
  File: string;
  LineNumber: number;
  LineContent: string;
  ContextBefore?: string[] | undefined;
  ContextAfter?: string[] | undefined;
}

export interface CodeSearchResult {
  success: boolean;
  output?: string;
  error?: string;
  aborted?: boolean;
}

function getRipgrepBinary(): string | null {
  const isWin = process.platform === 'win32';
  const fixedCandidates = isWin
    ? ['C:\\Program Files\\ripgrep\\rg.exe']
    : ['/opt/homebrew/bin/rg', '/usr/local/bin/rg', '/usr/bin/rg'];

  for (const candidate of fixedCandidates) {
    try {
      if (fsSync.existsSync(candidate)) return candidate;
    } catch {
      // Ignore permission errors probing candidate paths.
    }
  }

  const pathEnv = process.env.PATH || '';
  const exeName = isWin ? 'rg.exe' : 'rg';
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, exeName);
    try {
      if (fsSync.existsSync(candidate)) return candidate;
    } catch {
      // Ignore unreadable PATH directory entries.
    }
  }
  return null;
}

function globToSuffix(filePattern: string): string | null {
  if (!filePattern || filePattern === '*') return null;
  if (filePattern.startsWith('*.') && !filePattern.slice(2).includes('*')) {
    return filePattern.slice(1).toLowerCase();
  }
  return null;
}

function escapeLiteralRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function clampContextLines(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(10, Math.floor(value)));
}

function parseRgLineWithKind(line: string): { file: string; lineNumber: number; content: string; isContext: boolean } | null {
  const clean = line.endsWith('\r') ? line.slice(0, -1) : line;
  if (!clean || clean === '--') return null;
  const startOffset = /^[a-zA-Z]:[\\/]/.test(clean) ? 2 : 0;
  for (let i = startOffset; i < clean.length; i++) {
    const sep = clean[i];
    if (sep !== ':' && sep !== '-') continue;
    let j = i + 1;
    while (j < clean.length && clean.charCodeAt(j) >= 48 && clean.charCodeAt(j) <= 57) j++;
    if (j > i + 1 && clean[j] === sep) {
      return {
        file: clean.slice(0, i),
        lineNumber: Number.parseInt(clean.slice(i + 1, j), 10) || 0,
        content: clean.slice(j + 1).trim().slice(0, 300),
        isContext: sep === '-'
      };
    }
  }
  return null;
}

function parseRgMatches(stdout: string, maxMatches: number, withContext: boolean): CodeSearchMatch[] {
  const out: CodeSearchMatch[] = [];
  const pendingBefore: string[] = [];
  let lastMatch: CodeSearchMatch | null = null;
  for (const rawLine of stdout.split(/\r?\n/)) {
    if (!rawLine) continue;
    if (rawLine === '--') {
      pendingBefore.length = 0;
      lastMatch = null;
      continue;
    }
    const parsed = parseRgLineWithKind(rawLine);
    if (!parsed) continue;
    if (parsed.isContext) {
      if (!withContext) continue;
      if (lastMatch && lastMatch.File === parsed.file && parsed.lineNumber > lastMatch.LineNumber) {
        if (!lastMatch.ContextAfter) lastMatch.ContextAfter = [];
        lastMatch.ContextAfter.push(`${parsed.lineNumber}: ${parsed.content}`);
      } else {
        pendingBefore.push(`${parsed.lineNumber}: ${parsed.content}`);
      }
      continue;
    }
    if (out.length >= maxMatches) break;
    const match: CodeSearchMatch = {
      File: parsed.file,
      LineNumber: parsed.lineNumber,
      LineContent: parsed.content,
      ...(withContext && pendingBefore.length > 0 ? { ContextBefore: [...pendingBefore] } : {})
    };
    pendingBefore.length = 0;
    lastMatch = match;
    out.push(match);
  }
  return out;
}

function isInvalidGlob(filePattern: string): boolean {
  return (
    filePattern.startsWith('-') ||
    /[\x00-\x1f\r\n]/.test(filePattern)
  );
}

export const codeSearcher = {
  schema: {
    name: 'code.search_ripgrep',
    description:
      'Fast regex, literal string, and symbol search across codebases using ripgrep with bounded async Node fallback.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'The exact string, symbol, or regular expression pattern to look for across files.'
        },
        searchPath: {
          type: 'string',
          description: 'Directory or file path to search. Defaults to workspace root.'
        },
        isRegex: {
          type: 'boolean',
          description: 'If true, treats query as a regular expression pattern. If false, treats as literal string.'
        },
        caseInsensitive: {
          type: 'boolean',
          description: 'If true, performs case-insensitive search (default true).'
        },
        filePattern: {
          type: 'string',
          description: 'Optional glob filter (e.g. "*.js", "*.py", "*.kt", "*.ts") to restrict file extensions.'
        },
        astMode: {
          type: 'boolean',
          description: 'If true, filters results specifically for symbol definitions (classes, functions, interfaces, structs, defs).'
        },
        context: {
          type: 'integer',
          description: 'Number of surrounding context lines before and after each match (-C, 0-10).'
        },
        contextBefore: {
          type: 'integer',
          description: 'Number of context lines before each match (-B, 0-10).'
        },
        contextAfter: {
          type: 'integer',
          description: 'Number of context lines after each match (-A, 0-10).'
        },
        outputMode: {
          type: 'string',
          enum: ['content', 'files_with_matches', 'count'],
          description: 'Output mode: matching lines ("content"), matching file paths ("files_with_matches"), or match counts per file ("count").'
        },
        multiline: {
          type: 'boolean',
          description: 'If true, enable multiline matching across line boundaries (-U).'
        }
      },
      required: ['query']
    }
  },

  async execute(
    args: CodeSearchArgs,
    context?: SearchExecutionContext
  ): Promise<CodeSearchResult> {
    try {
      if (!args || typeof args.query !== 'string' || args.query.length === 0) {
        return { success: false, error: 'Query parameter is required.' };
      }

      const query = args.query;
      const isRegex = args.isRegex === true;
      const caseInsensitive = args.caseInsensitive !== false;
      const filePattern = typeof args.filePattern === 'string' ? args.filePattern.trim() : '*';
      const astMode = args.astMode === true;
      const contextBoth = clampContextLines(args.context);
      const contextBefore = clampContextLines(args.contextBefore) || contextBoth;
      const contextAfter = clampContextLines(args.contextAfter) || contextBoth;
      const multiline = args.multiline === true;
      const rawOutputMode = typeof args.outputMode === 'string' ? args.outputMode.trim().toLowerCase() : 'content';
      const outputMode: CodeSearchOutputMode =
        rawOutputMode === 'files_with_matches' || rawOutputMode === 'count' ? rawOutputMode : 'content';

      if (filePattern && filePattern !== '*' && isInvalidGlob(filePattern)) {
        return { success: false, error: `Invalid filePattern glob: ${filePattern}` };
      }

      if (isRegex) {
        const unsafeReason = validateRegexSafety(query);
        if (unsafeReason) {
          return { success: false, error: unsafeReason };
        }
      }

      const targetDir = resolveSearchRoot(args.searchPath, context);
      const scope = checkSearchScope(targetDir, context);
      if (!scope.allowed || !scope.realPath) {
        return { success: false, error: scope.error || `Search path not allowed: ${targetDir}` };
      }
      const realTargetDir = scope.realPath;

      let targetStat;
      try {
        targetStat = await fs.stat(realTargetDir);
      } catch {
        return { success: false, error: `Search path does not exist: ${targetDir}` };
      }

      const matches: CodeSearchMatch[] = [];
      const ignoreRoot = context?.parentLoop?.workspaceRoot?.trim() || context?.workspaceRoot?.trim() || realTargetDir;
      const causyneIgnore = loadWorkspaceIgnoreMatcher(ignoreRoot, { includeGitIgnore: false });
      const rgBin = getRipgrepBinary();
      let engineLabel = rgBin ? `Ripgrep Binary (${rgBin})` : 'Node Async Stream Engine';
      let useNodeFallback = !rgBin;
      let stoppedNotice = '';
      const withContext = outputMode === 'content' && (contextBefore > 0 || contextAfter > 0);

      const effectiveAstPattern = `(?:class|function|def|interface|struct|const|let|var|type|func|module|enum|trait)\\s+[^\\s(]*(?:${isRegex ? query : escapeLiteralRegex(query)})`;

      if (rgBin) {
        const rgArgs = [
          '-n',
          '--no-heading',
          '--with-filename',
          `--max-count=${RG_MAX_PER_FILE}`,
          `--max-filesize=${MAX_FILE_BYTES}`
        ];
        if (caseInsensitive) rgArgs.push('-i');
        if (!isRegex && !astMode) rgArgs.push('-F');
        if (multiline) rgArgs.push('-U');
        if (withContext && contextBefore > 0) rgArgs.push('-B', String(contextBefore));
        if (withContext && contextAfter > 0) rgArgs.push('-A', String(contextAfter));
        if (filePattern && filePattern !== '*') rgArgs.push('-g', filePattern);

        for (const glob of buildHomeGlobExcludes()) {
          rgArgs.push('-g', glob);
        }
        for (const glob of buildTopLevelHomeExcludes(realTargetDir)) {
          rgArgs.push('-g', glob);
        }
        for (const glob of causyneIgnore.toRipgrepGlobs()) {
          rgArgs.push('-g', glob);
        }

        const effectiveQuery = astMode ? effectiveAstPattern : query;
        rgArgs.push('-e', effectiveQuery, '--', realTargetDir);

        try {
          const { stdout } = await execFileAsync(rgBin, rgArgs, {
            maxBuffer: 10 * 1024 * 1024,
            timeout: DEFAULT_TIMEOUT_MS,
            signal: context?.signal
          });
          const parsedMatches = parseRgMatches(stdout, MAX_MATCHES * 2, withContext);
          for (const m of parsedMatches) {
            if (matches.length >= MAX_MATCHES) break;
            if (!causyneIgnore.isIgnored(m.File, false)) {
              matches.push(m);
            }
          }
        } catch (rgErr: unknown) {
          if (context?.signal?.aborted) {
            return { success: false, aborted: true, error: 'Code search aborted.' };
          }
          const errObj = rgErr as {
            code?: number | string | undefined;
            killed?: boolean | undefined;
            stdout?: string | undefined;
            stderr?: string | undefined;
          };
          if (typeof errObj.stdout === 'string' && errObj.stdout.length > 0) {
            for (const m of parseRgMatches(errObj.stdout, MAX_MATCHES * 2, withContext)) {
              if (matches.length >= MAX_MATCHES) break;
              if (!causyneIgnore.isIgnored(m.File, false)) {
                matches.push(m);
              }
            }
          }
          if (errObj.killed) {
            stoppedNotice = `stopped after ${DEFAULT_TIMEOUT_MS}ms budget`;
          } else if (errObj.code === 1) {
            // Exit code 1 means zero matches found.
          } else if (errObj.code === 2) {
            const stderr = String(errObj.stderr || '').trim();
            if (/regex parse error|error parsing regex/i.test(stderr)) {
              return { success: false, error: `Invalid regex pattern: ${stderr}` };
            }
            useNodeFallback = true;
          } else if (errObj.code === 'ENOENT' || errObj.code === 'EACCES') {
            useNodeFallback = true;
          } else if (matches.length === 0) {
            useNodeFallback = true;
          }
        }
      }

      if (useNodeFallback && matches.length === 0) {
        engineLabel = 'Node Async Stream Engine';
        let regex: RegExp;
        if (astMode) {
          try {
            regex = new RegExp(effectiveAstPattern, `${caseInsensitive ? 'i' : ''}${multiline ? 's' : ''}`);
          } catch (reErr: unknown) {
            return { success: false, error: `Invalid regex pattern: ${reErr instanceof Error ? reErr.message : String(reErr)}` };
          }
        } else {
          const compiled = compileSafeSearchRegex(query, { isRegex, caseInsensitive });
          if (!compiled.regex) {
            return { success: false, error: compiled.error || 'Invalid regex pattern.' };
          }
          regex = multiline ? new RegExp(compiled.regex.source, `${compiled.regex.flags}s`) : compiled.regex;
        }

        const extFilter = globToSuffix(filePattern);
        const guard = createTraversalGuard({ signal: context?.signal });
        const seen = new Set<string>();

        const scanFile = async (filePath: string): Promise<void> => {
          if (matches.length >= MAX_MATCHES || guard.checkStopped()) return;
          if (causyneIgnore.isIgnored(filePath, false)) return;
          if (extFilter && !filePath.toLowerCase().endsWith(extFilter)) return;
          if (!guard.countFile()) return;

          let fileStat;
          try {
            fileStat = await fs.stat(filePath);
          } catch {
            return;
          }
          if (fileStat.size > MAX_FILE_BYTES) return;
          if (await looksBinaryFile(filePath)) return;

          let content: string;
          try {
            content = await fs.readFile(filePath, 'utf8');
          } catch {
            return;
          }

          if (multiline) {
            const normalized = content.replace(/\r\n/g, '\n');
            const m = regex.exec(normalized);
            if (m) {
              const lineNum = normalized.slice(0, m.index).split('\n').length;
              matches.push({
                File: filePath,
                LineNumber: lineNum,
                LineContent: m[0].replace(/\s+/g, ' ').trim().slice(0, 300)
              });
            }
            return;
          }

          const lines = content.split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) {
            if (matches.length >= MAX_MATCHES || guard.checkStopped()) break;
            const line = lines[i]!;
            if (regex.test(line)) {
              const beforeLines = withContext && contextBefore > 0
                ? lines.slice(Math.max(0, i - contextBefore), i).map((l, idx) => `${Math.max(1, i - contextBefore + 1) + idx}: ${l.trim().slice(0, 200)}`)
                : undefined;
              const afterLines = withContext && contextAfter > 0
                ? lines.slice(i + 1, Math.min(lines.length, i + 1 + contextAfter)).map((l, idx) => `${i + 2 + idx}: ${l.trim().slice(0, 200)}`)
                : undefined;
              matches.push({
                File: filePath,
                LineNumber: i + 1,
                LineContent: line.trim().slice(0, 300),
                ...(beforeLines && beforeLines.length > 0 ? { ContextBefore: beforeLines } : {}),
                ...(afterLines && afterLines.length > 0 ? { ContextAfter: afterLines } : {})
              });
            }
          }
        };

        if (targetStat.isFile()) {
          await scanFile(realTargetDir);
        } else {
          const queue: Array<{ dir: string; real: string; depth: number }> = [
            { dir: realTargetDir, real: realTargetDir, depth: 0 }
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
                  if (isSafeSymlinkTarget(childReal, realTargetDir, context) && !seen.has(childReal)) {
                    queue.push({ dir: full, real: childReal, depth: current.depth + 1 });
                  }
                } catch {
                  // Ignore unreadable subdirectories.
                }
              } else if (dirent.isFile()) {
                await scanFile(full);
              } else if (dirent.isSymbolicLink()) {
                try {
                  const linkReal = await fs.realpath(full);
                  if (!isSafeSymlinkTarget(linkReal, realTargetDir, context)) continue;
                  const linkStat = await fs.stat(linkReal);
                  if (linkStat.isDirectory()) {
                    if (!seen.has(linkReal)) {
                      queue.push({ dir: linkReal, real: linkReal, depth: current.depth + 1 });
                    }
                  } else if (linkStat.isFile()) {
                    await scanFile(full);
                  }
                } catch {
                  // Ignore broken symlinks.
                }
              }
            }
          }
        }

        if (guard.stopReason === 'aborted') {
          return { success: false, aborted: true, error: 'Code search aborted.' };
        }
        if (guard.stopReason) {
          stoppedNotice = guard.stopNotice();
        }
      }

      if (outputMode === 'files_with_matches') {
        const files = [...new Set(matches.map((m) => m.File))];
        return {
          success: true,
          output: JSON.stringify(
            {
              engine: engineLabel,
              query,
              outputMode,
              total_files: files.length,
              ...(stoppedNotice ? { stopped_reason: stoppedNotice } : {}),
              files
            },
            null,
            2
          )
        };
      }

      if (outputMode === 'count') {
        const counts = new Map<string, number>();
        for (const m of matches) {
          counts.set(m.File, (counts.get(m.File) ?? 0) + 1);
        }
        return {
          success: true,
          output: JSON.stringify(
            {
              engine: engineLabel,
              query,
              outputMode,
              total_matches: matches.length,
              ...(stoppedNotice ? { stopped_reason: stoppedNotice } : {}),
              counts: [...counts.entries()].map(([File, Count]) => ({ File, Count }))
            },
            null,
            2
          )
        };
      }

      return {
        success: true,
        output: JSON.stringify(
          {
            engine: engineLabel,
            query,
            total_matches: matches.length,
            ...(stoppedNotice ? { stopped_reason: stoppedNotice } : {}),
            matches: matches.length > 0 ? matches : 'No matches found in target codebase.'
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
