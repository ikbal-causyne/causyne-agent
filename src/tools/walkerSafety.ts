import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  isPhysicalPathAllowed,
  isProtectedPhysicalPath,
  isWithinPhysicalPath,
  physicalPath
} from '../agent/workspaceBoundary.js';

export interface SearchExecutionContext {
  signal?: AbortSignal | undefined;
  workspacePaths?: readonly string[] | undefined;
  grantAllAccess?: boolean | undefined;
  parentLoop?: {
    workspaceRoot?: string | undefined;
  } | undefined;
}

export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_DIRS = 10_000;
export const DEFAULT_MAX_FILES = 25_000;
export const DEFAULT_MAX_DEPTH = 16;
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const SNIFF_BYTES = 8192;
export const MAX_REGEX_LENGTH = 500;
export const MAX_QUANTIFIER_REPEAT = 1000;

export const HEAVY_DEV_EXCLUDES: ReadonlySet<string> = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'target',
  '.gradle', '.m2', '.idea', '.vscode', '.next', '.nuxt', '.cache', '__pycache__',
  'venv', '.venv', 'vendor', 'Pods', 'DerivedData', 'coverage', '.terraform',
  '.causyne_trash', '.npm', '.nvm', '.pyenv', '.rustup', '.cargo', '.cocoapods',
  '.pub-cache'
]);

/**
 * Heavy user-home folders skipped ONLY when they sit directly inside $HOME.
 * Explicitly passing e.g. ~/Library/Logs or ~/.causyne/logs as searchPath still works.
 */
export const HOME_NOISE_EXCLUDES: ReadonlySet<string> = new Set([
  'Library', '.Trash', 'Applications', 'Movies', 'Music', 'Pictures',
  'CloudStorage', 'CoreSimulator', '.causyne', '.opencode', '.local',
  '.android', 'AppData', '$RECYCLE.BIN', 'System Volume Information'
]);

export const BINARY_EXTENSIONS_RE =
  /\.(png|jpe?g|webp|gif|svg|bmp|ico|woff2?|ttf|otf|eot|blend\d?|glb|gltf|wasm|zip|tar|gz|bz2|xz|7z|rar|mp4|mov|avi|mkv|webm|mp3|wav|ogg|flac|aac|m4a|pdf|exe|dll|dylib|so|jar|class|o|a|bin|iso|dmg|img|sqlite|db)$/i;

export function expandHomePath(raw: string): string {
  const trimmed = raw.trim();
  const home = os.homedir();
  if (trimmed === '~') return home;
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return path.join(home, trimmed.slice(2));
  }
  return trimmed;
}

function defaultBaseDir(context?: SearchExecutionContext): string {
  const fromLoop = context?.parentLoop?.workspaceRoot;
  if (typeof fromLoop === 'string' && fromLoop.trim()) {
    return path.resolve(expandHomePath(fromLoop));
  }
  const firstWs = context?.workspacePaths?.find(
    (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0
  );
  if (firstWs) {
    return path.resolve(expandHomePath(firstWs));
  }
  return process.cwd();
}

export function resolveSearchRoot(rawPath: unknown, context?: SearchExecutionContext): string {
  const baseDir = defaultBaseDir(context);
  if (typeof rawPath === 'string' && rawPath.trim()) {
    const expanded = expandHomePath(rawPath);
    return path.resolve(baseDir, expanded);
  }
  return baseDir;
}

export interface SearchScopeResult {
  allowed: boolean;
  resolvedPath: string;
  realPath: string | null;
  error?: string | undefined;
}

export function checkSearchScope(
  candidatePath: string,
  context?: SearchExecutionContext
): SearchScopeResult {
  const expanded = expandHomePath(candidatePath);
  const resolved = path.resolve(defaultBaseDir(context), expanded);
  const real = physicalPath(resolved);

  if (!real) {
    return {
      allowed: false,
      resolvedPath: resolved,
      realPath: null,
      error: `Path is inaccessible or resolves through a broken/looping symlink: ${candidatePath}`
    };
  }

  if (isProtectedPhysicalPath(resolved) || isProtectedPhysicalPath(real)) {
    return {
      allowed: false,
      resolvedPath: resolved,
      realPath: real,
      error: `Cannot search protected system path: ${candidatePath}`
    };
  }

  if (
    Array.isArray(context?.workspacePaths) &&
    context.workspacePaths.length > 0 &&
    context.grantAllAccess !== true
  ) {
    const allowedRoots = context.workspacePaths
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      .map(expandHomePath);
    if (allowedRoots.length > 0 && !isPhysicalPathAllowed(resolved, allowedRoots, false)) {
      return {
        allowed: false,
        resolvedPath: resolved,
        realPath: real,
        error: `Path outside allowed workspace: ${candidatePath}`
      };
    }
  }

  return {
    allowed: true,
    resolvedPath: resolved,
    realPath: real
  };
}

export function isSafeSymlinkTarget(
  linkTargetReal: string,
  rootReal: string,
  context?: SearchExecutionContext
): boolean {
  if (isProtectedPhysicalPath(linkTargetReal)) return false;
  if (!isWithinPhysicalPath(linkTargetReal, rootReal)) return false;
  if (
    Array.isArray(context?.workspacePaths) &&
    context.workspacePaths.length > 0 &&
    context.grantAllAccess !== true
  ) {
    const allowedRoots = context.workspacePaths
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
      .map(expandHomePath);
    if (allowedRoots.length > 0 && !isPhysicalPathAllowed(linkTargetReal, allowedRoots, false)) {
      return false;
    }
  }
  return true;
}

export function normalizeComparePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function realHomeDir(): string {
  const home = os.homedir();
  try {
    return fsSync.realpathSync.native(home);
  } catch {
    return path.resolve(home);
  }
}

export function shouldExcludeChild(
  currentDirReal: string,
  childName: string,
  ignorePatterns: readonly string[] = []
): boolean {
  if (HEAVY_DEV_EXCLUDES.has(childName)) return true;
  if (
    HOME_NOISE_EXCLUDES.has(childName) &&
    normalizeComparePath(currentDirReal) === normalizeComparePath(realHomeDir())
  ) {
    return true;
  }
  for (const pattern of ignorePatterns) {
    if (pattern === childName) return true;
    if (pattern.startsWith('*') && childName.endsWith(pattern.slice(1))) return true;
    if (pattern.endsWith('*') && childName.startsWith(pattern.slice(0, -1))) return true;
  }
  return false;
}

export async function loadGitIgnoreNames(rootDir: string): Promise<string[]> {
  const patterns: string[] = [];
  try {
    const raw = await fs.readFile(path.join(rootDir, '.gitignore'), 'utf8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;
      let start = 0;
      let end = trimmed.length;
      while (start < end && trimmed[start] === '/') start++;
      while (end > start && trimmed[end - 1] === '/') end--;
      const cleaned = trimmed.slice(start, end);
      if (cleaned) patterns.push(cleaned);
    }
  } catch {
    // Missing or unreadable .gitignore is normal outside repos.
  }
  return patterns;
}

export async function looksBinaryFile(filePath: string): Promise<boolean> {
  if (BINARY_EXTENSIONS_RE.test(filePath)) return true;
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(filePath, 'r');
    const buffer = Buffer.alloc(SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, SNIFF_BYTES, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } catch {
    return true;
  } finally {
    if (handle) {
      await handle.close().catch(() => {});
    }
  }
}

export interface TraversalGuardOptions {
  maxDirs?: number | undefined;
  maxFiles?: number | undefined;
  maxDepth?: number | undefined;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
}

export type TraversalStopReason = 'aborted' | 'timeout' | 'max_dirs' | 'max_files' | null;

export class TraversalGuard {
  readonly maxDirs: number;
  readonly maxFiles: number;
  readonly maxDepth: number;
  readonly timeoutMs: number;
  readonly signal: AbortSignal | undefined;
  readonly startedAt: number;
  dirsVisited = 0;
  filesVisited = 0;
  stopReason: TraversalStopReason = null;

  constructor(options: TraversalGuardOptions = {}) {
    this.maxDirs = options.maxDirs ?? DEFAULT_MAX_DIRS;
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.signal = options.signal;
    this.startedAt = Date.now();
  }

  checkStopped(): TraversalStopReason {
    if (this.stopReason) return this.stopReason;
    if (this.signal?.aborted) {
      this.stopReason = 'aborted';
      return this.stopReason;
    }
    if (Date.now() - this.startedAt >= this.timeoutMs) {
      this.stopReason = 'timeout';
      return this.stopReason;
    }
    return null;
  }

  enterDir(depth: number): boolean {
    if (this.checkStopped()) return false;
    if (depth > this.maxDepth) return false;
    if (this.dirsVisited >= this.maxDirs) {
      this.stopReason = 'max_dirs';
      return false;
    }
    this.dirsVisited++;
    return true;
  }

  countFile(): boolean {
    if (this.checkStopped()) return false;
    if (this.filesVisited >= this.maxFiles) {
      this.stopReason = 'max_files';
      return false;
    }
    this.filesVisited++;
    return true;
  }

  stopNotice(): string {
    switch (this.stopReason) {
      case 'timeout':
        return `stopped after ${this.timeoutMs}ms budget (narrow search path or filter to continue)`;
      case 'max_dirs':
        return `stopped after visiting ${this.dirsVisited} directories (narrow search path)`;
      case 'max_files':
        return `stopped after inspecting ${this.filesVisited} files (narrow search path)`;
      case 'aborted':
        return 'aborted';
      default:
        return '';
    }
  }
}

export function createTraversalGuard(options: TraversalGuardOptions = {}): TraversalGuard {
  return new TraversalGuard(options);
}

interface ParenFrame {
  hasMultiRepeat: boolean;
  hasAlternation: boolean;
}

/**
 * Linear-time O(n) character scanner that rejects pathological regex patterns
 * (e.g. `(a+)+`, `(a|aa)+`, huge `{m,n}` counts, oversized patterns) without
 * itself invoking any backtracking regular expression.
 */
export function validateRegexSafety(pattern: string): string | null {
  if (typeof pattern !== 'string' || pattern.length === 0) {
    return 'Regular expression pattern must be a non-empty string.';
  }
  if (pattern.length > MAX_REGEX_LENGTH) {
    return `Regular expression exceeds maximum length of ${MAX_REGEX_LENGTH} characters.`;
  }

  const stack: ParenFrame[] = [{ hasMultiRepeat: false, hasAlternation: false }];
  let inCharClass = false;
  let lastTokenWasQuantifiable = false;
  let lastGroupFrame: ParenFrame | null = null;

  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '\\') {
      if (i + 1 >= pattern.length) {
        return 'Trailing backslash in regular expression.';
      }
      const next = pattern[i + 1]!;
      if (!inCharClass && next >= '1' && next <= '9') {
        return 'Backreferences are disallowed in search regular expressions for ReDoS safety.';
      }
      i++;
      lastTokenWasQuantifiable = true;
      lastGroupFrame = null;
      continue;
    }

    if (inCharClass) {
      if (ch === ']') {
        inCharClass = false;
        lastTokenWasQuantifiable = true;
        lastGroupFrame = null;
      }
      continue;
    }

    if (ch === '[') {
      inCharClass = true;
      lastTokenWasQuantifiable = false;
      lastGroupFrame = null;
      continue;
    }

    if (ch === '(') {
      stack.push({ hasMultiRepeat: false, hasAlternation: false });
      lastTokenWasQuantifiable = false;
      lastGroupFrame = null;
      continue;
    }

    if (ch === ')') {
      if (stack.length <= 1) {
        lastTokenWasQuantifiable = false;
        lastGroupFrame = null;
        continue;
      }
      const popped = stack.pop()!;
      const parent = stack[stack.length - 1]!;
      if (popped.hasMultiRepeat) parent.hasMultiRepeat = true;
      lastGroupFrame = popped;
      lastTokenWasQuantifiable = true;
      continue;
    }

    if (ch === '|') {
      const top = stack[stack.length - 1]!;
      top.hasAlternation = true;
      lastTokenWasQuantifiable = false;
      lastGroupFrame = null;
      continue;
    }

    let isMultiRepeat = false;
    let isAnyQuantifier = false;
    let jumpTo = i;

    if (ch === '*' || ch === '+') {
      isAnyQuantifier = true;
      isMultiRepeat = true;
    } else if (ch === '?') {
      if (lastTokenWasQuantifiable) {
        isAnyQuantifier = true;
        isMultiRepeat = false;
      }
    } else if (ch === '{') {
      let j = i + 1;
      let first = '';
      let second = '';
      let seenComma = false;
      let validBrace = false;
      while (j < pattern.length) {
        const c = pattern[j]!;
        if (c >= '0' && c <= '9') {
          if (seenComma) second += c;
          else first += c;
          j++;
        } else if (c === ',' && !seenComma && first.length > 0) {
          seenComma = true;
          j++;
        } else if (c === '}' && first.length > 0) {
          validBrace = true;
          break;
        } else {
          break;
        }
      }
      if (validBrace) {
        const minCount = Number.parseInt(first, 10);
        const maxCount = seenComma
          ? (second.length > 0 ? Number.parseInt(second, 10) : Infinity)
          : minCount;
        if (minCount > MAX_QUANTIFIER_REPEAT || (Number.isFinite(maxCount) && maxCount > MAX_QUANTIFIER_REPEAT)) {
          return `Quantifier repetition count exceeds ${MAX_QUANTIFIER_REPEAT}.`;
        }
        isAnyQuantifier = true;
        isMultiRepeat = maxCount > 1;
        jumpTo = j;
      }
    }

    if (isAnyQuantifier) {
      i = jumpTo;
      if (i + 1 < pattern.length && pattern[i + 1] === '?') {
        i++; // lazy modifier
      }
      if (isMultiRepeat) {
        const top = stack[stack.length - 1]!;
        top.hasMultiRepeat = true;
        if (lastGroupFrame && (lastGroupFrame.hasMultiRepeat || lastGroupFrame.hasAlternation)) {
          return 'Nested quantifiers are disallowed to prevent catastrophic backtracking (ReDoS).';
        }
      }
      lastTokenWasQuantifiable = false;
      lastGroupFrame = null;
      continue;
    }

    lastTokenWasQuantifiable = true;
    lastGroupFrame = null;
  }

  return null;
}

export function compileSafeSearchRegex(
  query: string,
  options: { isRegex?: boolean | undefined; caseInsensitive?: boolean | undefined } = {}
): { regex?: RegExp; error?: string } {
  if (typeof query !== 'string' || query.length === 0) {
    return { error: 'Query must be a non-empty string.' };
  }
  const flags = options.caseInsensitive ? 'i' : '';
  if (!options.isRegex) {
    const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return { regex: new RegExp(escaped, flags) };
  }
  const unsafeReason = validateRegexSafety(query);
  if (unsafeReason) {
    return { error: unsafeReason };
  }
  try {
    return { regex: new RegExp(query, flags) };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : String(error);
    return { error: `Invalid regular expression: ${msg}` };
  }
}

export function buildHomeGlobExcludes(): string[] {
  const excludes: string[] = [];
  for (const name of HEAVY_DEV_EXCLUDES) {
    excludes.push(`!**/${name}/**`);
  }
  return excludes;
}

export function buildTopLevelHomeExcludes(targetRealPath: string): string[] {
  if (normalizeComparePath(targetRealPath) !== normalizeComparePath(realHomeDir())) {
    return [];
  }
  const excludes: string[] = [];
  for (const name of HOME_NOISE_EXCLUDES) {
    excludes.push(`!${name}/**`);
  }
  return excludes;
}
