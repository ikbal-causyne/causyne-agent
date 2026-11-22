import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { isPhysicalPathAllowed, isWithinPhysicalPath, physicalPath } from '../agent/workspaceBoundary.js';
import { ensureSafeWorkspaceInputPath, ensureSafeWorkspaceOutputPath } from '../browser/workspacePathSafety.js';
import { redactProviderSecrets } from '../providers/byokHttp.js';
import { safeDisplay } from '../tui/text.js';
import { resolveUserPath } from '../utils/paths.js';

export interface ToolWorkspaceContext {
  workspaceRoot?: string | undefined;
  workspacePaths?: readonly string[] | undefined;
  grantAllAccess?: boolean | undefined;
  signal?: AbortSignal | undefined;
  isPathAllowed?: ((targetPath: string) => boolean) | undefined;
  parentLoop?: {
    workspaceRoot?: string | undefined;
    taskId?: string | undefined;
    subagentDepth?: number | undefined;
    sandbox?: ToolWorkspaceContext | undefined;
    eventSink?: { readyState?: number | undefined } | undefined;
    emitEvent?: ((event: Record<string, unknown>) => void) | undefined;
  } | null | undefined;
}

export interface ResolvedWorkspaceScope {
  grantAllAccess: boolean;
  roots: string[];
  primaryRoot: string | null;
  policy: ToolWorkspaceContext | null;
}

const WINDOWS_RESERVED_BASENAMES = new Set([
  'con', 'prn', 'aux', 'nul',
  'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
  'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9'
]);

const HTML_ESCAPE_MAP: Readonly<Record<string, string>> = Object.freeze({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
});

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function sanitizeToolError(error: unknown, maxLen = 600): string {
  const raw = getErrorMessage(error);
  return safeDisplay(redactProviderSecrets(raw)).replace(/[\r\n]+/g, ' ').trim().slice(0, maxLen);
}

export function sanitizeToolText(value: unknown, maxLen = 4096): string {
  return safeDisplay(redactProviderSecrets(String(value ?? ''))).slice(0, maxLen);
}

export function resolveToolWorkspaceRoots(context?: ToolWorkspaceContext | null): ResolvedWorkspaceScope {
  const safeCtx = context && typeof context === 'object' ? context : null;
  const sandboxPolicy = safeCtx?.parentLoop?.sandbox && typeof safeCtx.parentLoop.sandbox === 'object'
    ? safeCtx.parentLoop.sandbox
    : safeCtx;
  const grantAllAccess = Boolean(sandboxPolicy?.grantAllAccess || safeCtx?.grantAllAccess);
  const rawRoots: string[] = [];

  const pushRoot = (candidate: unknown): void => {
    if (typeof candidate !== 'string') return;
    const trimmed = candidate.trim();
    if (!trimmed || trimmed.includes('\0')) return;
    const resolved = path.resolve(resolveUserPath(trimmed));
    if (!rawRoots.includes(resolved)) rawRoots.push(resolved);
  };

  if (Array.isArray(sandboxPolicy?.workspacePaths)) {
    for (const entry of sandboxPolicy.workspacePaths) pushRoot(entry);
  }
  pushRoot(sandboxPolicy?.workspaceRoot);
  if (Array.isArray(safeCtx?.workspacePaths)) {
    for (const entry of safeCtx.workspacePaths) pushRoot(entry);
  }
  pushRoot(safeCtx?.workspaceRoot);
  pushRoot(safeCtx?.parentLoop?.workspaceRoot);

  return {
    grantAllAccess,
    roots: rawRoots,
    primaryRoot: rawRoots[0] ?? null,
    policy: sandboxPolicy ?? null
  };
}

export function resolveScopedPath(
  rawPath: unknown,
  context?: ToolWorkspaceContext | null,
  options: { defaultBase?: string | undefined } = {}
): string {
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    throw new Error('A non-empty file path is required');
  }
  if (rawPath.includes('\0')) {
    throw new Error('File path cannot contain NUL bytes');
  }
  const scope = resolveToolWorkspaceRoots(context);
  const baseDir = scope.primaryRoot || options.defaultBase || process.cwd();
  const trimmed = rawPath.trim();
  const resolved = (trimmed === '~' || trimmed.startsWith('~/') || trimmed.startsWith('~\\'))
    ? resolveUserPath(trimmed)
    : (path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(baseDir, trimmed));

  if (!scope.grantAllAccess && scope.roots.length > 0) {
    if (typeof scope.policy?.isPathAllowed === 'function' && !scope.policy.isPathAllowed(resolved)) {
      throw new Error('Target path is outside the authorized workspace');
    }
    if (!isPhysicalPathAllowed(resolved, scope.roots)) {
      throw new Error('Target path resolves outside the authorized workspace');
    }
  }
  return resolved;
}

export function findContainingRoot(target: string, roots: readonly string[]): string | null {
  const physicalTarget = physicalPath(target);
  if (!physicalTarget) return null;
  for (const root of roots) {
    const physicalRoot = physicalPath(root);
    if (physicalRoot && isWithinPhysicalPath(physicalTarget, physicalRoot)) {
      return root;
    }
  }
  return null;
}

export async function assertSafeWorkspaceOutput(
  rawPath: unknown,
  context?: ToolWorkspaceContext | null,
  options: { defaultBase?: string | undefined; scopeRoot?: string | undefined } = {}
): Promise<string> {
  const scope = resolveToolWorkspaceRoots(context);
  const resolved = resolveScopedPath(rawPath, context, { defaultBase: options.defaultBase });
  const enforcedRoot = options.scopeRoot
    ? path.resolve(options.scopeRoot)
    : (!scope.grantAllAccess && scope.roots.length > 0 ? findContainingRoot(resolved, scope.roots) : null);

  if (enforcedRoot) {
    await ensureSafeWorkspaceOutputPath(enforcedRoot, resolved);
    return resolved;
  }

  await fs.mkdir(path.dirname(resolved), { recursive: true });
  const existing = await fs.lstat(resolved).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
    throw new Error('Output target cannot be a symlink or directory');
  }
  return resolved;
}

export async function assertSafeWorkspaceInput(
  rawPath: unknown,
  context?: ToolWorkspaceContext | null,
  options: { defaultBase?: string | undefined; scopeRoot?: string | undefined; maxBytes?: number | undefined } = {}
): Promise<{ resolved: string; size: number }> {
  const scope = resolveToolWorkspaceRoots(context);
  const resolved = resolveScopedPath(rawPath, context, { defaultBase: options.defaultBase });
  const enforcedRoot = options.scopeRoot
    ? path.resolve(options.scopeRoot)
    : (!scope.grantAllAccess && scope.roots.length > 0 ? findContainingRoot(resolved, scope.roots) : null);

  if (enforcedRoot) {
    await ensureSafeWorkspaceInputPath(enforcedRoot, resolved);
  }
  const lstat = await fs.lstat(resolved);
  if (lstat.isSymbolicLink() && !enforcedRoot) {
    const stat = await fs.stat(resolved);
    if (!stat.isFile()) throw new Error('Input target must be a regular file');
    if (options.maxBytes !== undefined && stat.size > options.maxBytes) {
      throw new Error(`File exceeds the maximum allowed size of ${options.maxBytes} bytes`);
    }
    return { resolved, size: stat.size };
  }
  if (!lstat.isFile()) {
    throw new Error('Input target must be a regular file');
  }
  if (options.maxBytes !== undefined && lstat.size > options.maxBytes) {
    throw new Error(`File exceeds the maximum allowed size of ${options.maxBytes} bytes`);
  }
  return { resolved, size: lstat.size };
}

export async function atomicWriteFileSafe(
  targetPath: string,
  content: string | Buffer,
  options: { mode?: number | undefined } = {}
): Promise<void> {
  const existing = await fs.lstat(targetPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing?.isSymbolicLink() || (existing && !existing.isFile())) {
    throw new Error('Output target cannot be a symlink or directory');
  }
  const dir = path.dirname(targetPath);
  const tempPath = path.join(
    dir,
    `.${path.basename(targetPath)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`
  );
  try {
    const handle = await fs.open(tempPath, 'wx', options.mode ?? 0o600);
    try {
      await handle.writeFile(content);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tempPath, targetPath);
  } catch (error: unknown) {
    await fs.unlink(tempPath).catch(() => {});
    throw error;
  }
}

export function escapeHtmlText(value: unknown, maxLen = 200): string {
  const input = String(value ?? '').slice(0, maxLen);
  return input.replace(/[&<>"']/g, (ch) => HTML_ESCAPE_MAP[ch] ?? ch);
}

export function escapeJsString(value: unknown, maxLen = 200): string {
  const input = String(value ?? '').slice(0, maxLen);
  return JSON.stringify(input)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function escapeGodotString(value: unknown, maxLen = 200): string {
  // eslint-disable-next-line no-control-regex
  const singleLine = String(value ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, maxLen);
  return singleLine.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function safeSlugIdentifier(value: unknown, fallback = 'item', maxLen = 64): string {
  const raw = String(value ?? '');
  let out = '';
  for (let i = 0; i < raw.length && out.length < maxLen; i++) {
    const code = raw.charCodeAt(i);
    const isAlnum = (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
    if (isAlnum || code === 95 || code === 45) {
      out += raw[i]!;
    } else if (out.length > 0 && !out.endsWith('_')) {
      out += '_';
    }
  }
  let start = 0;
  let end = out.length;
  while (start < end && (out[start] === '_' || out[start] === '-')) start++;
  while (end > start && (out[end - 1] === '_' || out[end - 1] === '-')) end--;
  const trimmed = out.slice(start, end);
  return trimmed.length > 0 ? trimmed : fallback;
}

export function safeFilenameStrict(value: unknown, maxLen = 200): string | null {
  if (typeof value !== 'string') return null;
  if (value.length === 0 || value.length > maxLen) return null;
  if (value === '.' || value === '..') return null;
  // eslint-disable-next-line no-control-regex
  if (/[<>:"/\\|?*\x00-\x1f\x7f]/.test(value)) return null;
  if (value.endsWith(' ') || value.endsWith('.')) return null;
  const stem = value.split('.')[0]?.toLowerCase() ?? '';
  if (WINDOWS_RESERVED_BASENAMES.has(stem)) return null;
  return value;
}

export function isSafePlainKey(key: unknown): key is string {
  return typeof key === 'string'
    && key.length > 0
    && key.length <= 128
    && key !== '__proto__'
    && key !== 'constructor'
    && key !== 'prototype';
}

export function stripDangerousKeysDeep<T>(value: T, depth = 0): T {
  if (depth > 24 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((item) => stripDangerousKeysDeep(item, depth + 1)) as unknown as T;
  }
  const clean: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!isSafePlainKey(k)) continue;
    clean[k] = stripDangerousKeysDeep(v, depth + 1);
  }
  return Object.assign({}, clean) as T;
}

export function boundedFiniteNumber(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  return Math.round(boundedFiniteNumber(value, fallback, min, max));
}
