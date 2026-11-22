/**
 * Causyne Agent — Isolated Git Worktree Manager (Phase B2)
 *
 * Creates, inspects, diffs, merges, and cleans up isolated `git worktree`
 * checkouts under `<repo>/.causyne-worktrees/<id>` so parallel subagents or
 * speculative refactors never collide on the user's primary working tree.
 *
 * Security invariants:
 *   - All Git invocations use `execFileSync('git', argv, { shell: false })`.
 *   - Refuses blocked system roots (`isBlockedWorkspaceRoot`) and symlink escapes.
 *   - Strict worktree ID and ref validation — never accepts flags starting with `-`.
 *   - Aborts conflicting merges cleanly so the primary branch is never corrupted.
 */

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isBlockedWorkspaceRoot } from './sandboxPolicy.js';
import { safeDisplay } from './tui/text.js';

export interface WorktreeInfo {
  id: string;
  path: string;
  head: string;
  branch: string | null;
  managed: boolean;
  bare: boolean;
  detached: boolean;
}

export interface CreatedWorktree {
  id: string;
  path: string;
  branch: string;
  baseBranch: string;
  baseCommit: string;
  repoRoot: string;
}

export interface WorktreeDiffReport {
  id: string;
  path: string;
  branch: string | null;
  changedFiles: string[];
  uncommittedFiles: string[];
  stat: string;
  diff: string;
  truncated: boolean;
}

export interface WorktreeMergeResult {
  merged: boolean;
  conflict: boolean;
  branch: string;
  summary: string;
  error?: string | undefined;
}

const WORKTREE_CONTAINER_DIR = '.causyne-worktrees';
const BRANCH_PREFIX = 'causyne/wt-';
const WORKTREE_ID_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const SAFE_GIT_REF_RE = /^[a-zA-Z0-9._/@^~-]{1,128}$/;
const MAX_DIFF_CHARS = 64 * 1024;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

function runGit(args: readonly string[], cwd: string): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: GIT_MAX_BUFFER,
    timeout: 30_000,
    windowsHide: true
  });
}

function gitErrorDetail(err: unknown): string {
  if (err && typeof err === 'object') {
    const rec = err as { stderr?: unknown; stdout?: unknown; message?: unknown };
    const stderr = typeof rec.stderr === 'string' ? rec.stderr.trim() : '';
    if (stderr) return safeDisplay(stderr).slice(0, 500);
    if (typeof rec.message === 'string') return safeDisplay(rec.message).slice(0, 500);
  }
  return safeDisplay(String(err)).slice(0, 500);
}

function isInsideDir(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

export function resolveGitRepoRoot(dir: string): string | null {
  if (typeof dir !== 'string' || !dir.trim() || dir.includes('\0')) return null;
  const resolved = path.resolve(dir);
  if (isBlockedWorkspaceRoot(resolved)) return null;
  try {
    const top = runGit(['rev-parse', '--show-toplevel'], resolved).trim();
    if (!top) return null;
    const realTop = fs.realpathSync(top);
    if (isBlockedWorkspaceRoot(realTop)) return null;
    return realTop;
  } catch {
    return null;
  }
}

export function sanitizeWorktreeId(raw?: string): string {
  const cleaned = typeof raw === 'string'
    ? raw.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-')
    : '';
  let start = 0;
  let end = cleaned.length;
  while (start < end && cleaned[start] === '-') start++;
  while (end > start && cleaned[end - 1] === '-') end--;
  const base = cleaned.slice(start, end).slice(0, 32);
  const suffix = crypto.randomBytes(3).toString('hex');
  const candidate = base ? `${base}-${suffix}` : `wt-${suffix}`;
  return WORKTREE_ID_RE.test(candidate) ? candidate : `wt-${suffix}`;
}

export function validateWorktreeId(id: string): string {
  if (typeof id !== 'string' || !WORKTREE_ID_RE.test(id)) {
    throw new Error(`Invalid worktree id "${safeDisplay(String(id))}". Use 1-48 lowercase letters, digits, hyphens, or underscores.`);
  }
  return id;
}

function ensureWorktreeContainerExcluded(repoRoot: string): void {
  try {
    const commonDirRaw = runGit(['rev-parse', '--git-common-dir'], repoRoot).trim();
    if (!commonDirRaw) return;
    const commonDir = path.isAbsolute(commonDirRaw) ? commonDirRaw : path.resolve(repoRoot, commonDirRaw);
    const infoDir = path.join(commonDir, 'info');
    const excludeFile = path.join(infoDir, 'exclude');
    fs.mkdirSync(infoDir, { recursive: true });
    let existing = '';
    try {
      const stat = fs.lstatSync(excludeFile);
      if (stat.isSymbolicLink() || !stat.isFile()) return;
      existing = fs.readFileSync(excludeFile, 'utf8');
    } catch {
      existing = '';
    }
    const entry = `${WORKTREE_CONTAINER_DIR}/`;
    const lines = existing.split(/\r?\n/).map((l) => l.trim());
    if (!lines.includes(entry)) {
      const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
      fs.appendFileSync(excludeFile, `${prefix}${entry}\n`, 'utf8');
    }
  } catch {
    // Non-fatal: exclude update is best-effort
  }
}

export function listWorktrees(dir: string): WorktreeInfo[] {
  const repoRoot = resolveGitRepoRoot(dir);
  if (!repoRoot) return [];
  const managedContainer = path.join(repoRoot, WORKTREE_CONTAINER_DIR);
  let output = '';
  try {
    output = runGit(['worktree', 'list', '--porcelain'], repoRoot);
  } catch {
    return [];
  }

  const results: WorktreeInfo[] = [];
  const blocks = output.split(/\r?\n\r?\n/).map((b) => b.trim()).filter(Boolean);
  for (const block of blocks) {
    let wtPath = '';
    let head = '';
    let branch: string | null = null;
    let bare = false;
    let detached = false;
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) {
        wtPath = line.slice('worktree '.length).trim();
      } else if (line.startsWith('HEAD ')) {
        head = line.slice('HEAD '.length).trim();
      } else if (line.startsWith('branch ')) {
        const ref = line.slice('branch '.length).trim();
        branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
      } else if (line === 'bare') {
        bare = true;
      } else if (line === 'detached') {
        detached = true;
      }
    }
    if (!wtPath) continue;
    let resolvedWtPath = path.resolve(wtPath);
    try { resolvedWtPath = fs.realpathSync(resolvedWtPath); } catch { /* keep resolved */ }
    const managed = isInsideDir(managedContainer, resolvedWtPath);
    const id = managed ? path.basename(resolvedWtPath) : path.basename(resolvedWtPath);
    results.push({ id, path: resolvedWtPath, head, branch, managed, bare, detached });
  }
  return results;
}

export function createWorktree(
  dir: string,
  options: { name?: string | undefined; baseRef?: string | undefined } = {}
): CreatedWorktree {
  const repoRoot = resolveGitRepoRoot(dir);
  if (!repoRoot) {
    throw new Error('Target workspace is not inside a valid Git repository.');
  }

  const baseRef = typeof options.baseRef === 'string' && options.baseRef.trim() ? options.baseRef.trim() : 'HEAD';
  if (baseRef.startsWith('-') || !SAFE_GIT_REF_RE.test(baseRef)) {
    throw new Error(`Invalid base git ref "${safeDisplay(baseRef)}".`);
  }

  let baseCommit: string;
  try {
    baseCommit = runGit(['rev-parse', '--verify', `${baseRef}^{commit}`], repoRoot).trim();
  } catch (err: unknown) {
    throw new Error(`Could not resolve base commit "${safeDisplay(baseRef)}": ${gitErrorDetail(err)}`);
  }

  let baseBranch = 'HEAD';
  try {
    baseBranch = runGit(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot).trim() || 'HEAD';
  } catch { /* ignore */ }

  const id = sanitizeWorktreeId(options.name);
  const branch = `${BRANCH_PREFIX}${id}`;
  const container = path.join(repoRoot, WORKTREE_CONTAINER_DIR);
  ensureWorktreeContainerExcluded(repoRoot);
  fs.mkdirSync(container, { recursive: true });

  const containerStat = fs.lstatSync(container);
  if (containerStat.isSymbolicLink() || !containerStat.isDirectory()) {
    throw new Error('Refusing symlink or non-directory worktree container.');
  }

  const targetPath = path.join(container, id);
  if (!isInsideDir(container, targetPath)) {
    throw new Error('Resolved worktree path escaped container.');
  }
  if (fs.existsSync(targetPath)) {
    throw new Error(`Worktree path already exists: ${safeDisplay(targetPath)}`);
  }

  try {
    runGit(['worktree', 'add', '-b', branch, targetPath, baseCommit], repoRoot);
  } catch (err: unknown) {
    throw new Error(`Failed to create git worktree: ${gitErrorDetail(err)}`);
  }

  let finalPath = targetPath;
  try { finalPath = fs.realpathSync(targetPath); } catch { /* keep targetPath */ }

  return {
    id,
    path: finalPath,
    branch,
    baseBranch,
    baseCommit,
    repoRoot
  };
}

function findManagedWorktree(repoRoot: string, id: string): WorktreeInfo {
  const safeId = validateWorktreeId(id);
  const all = listWorktrees(repoRoot);
  const found = all.find((w) => w.managed && w.id === safeId);
  if (!found) {
    throw new Error(`Managed worktree "${safeId}" not found.`);
  }
  return found;
}

export function inspectWorktreeDiff(dir: string, worktreeId: string): WorktreeDiffReport {
  const repoRoot = resolveGitRepoRoot(dir);
  if (!repoRoot) throw new Error('Target workspace is not inside a valid Git repository.');
  const wt = findManagedWorktree(repoRoot, worktreeId);

  const porcelain = runGit(['status', '--porcelain'], wt.path).trim();
  const uncommittedFiles = porcelain
    ? porcelain.split(/\r?\n/).map((line) => line.slice(3).trim()).filter(Boolean)
    : [];

  let baseCommit = '';
  try {
    baseCommit = runGit(['merge-base', 'HEAD', wt.head || 'HEAD'], repoRoot).trim();
  } catch {
    baseCommit = '';
  }

  const changedSet = new Set<string>(uncommittedFiles);
  let committedDiff = '';
  let stat = '';
  if (baseCommit) {
    try {
      const names = runGit(['diff', '--name-only', baseCommit, '--'], wt.path).trim();
      for (const n of names.split(/\r?\n/).filter(Boolean)) changedSet.add(n);
      stat = runGit(['diff', '--stat', baseCommit, '--'], wt.path).trim();
      committedDiff = runGit(['diff', baseCommit, '--'], wt.path);
    } catch {
      // Fallback to working-tree diff only
    }
  }
  if (!committedDiff && uncommittedFiles.length > 0) {
    try {
      stat = runGit(['diff', '--stat'], wt.path).trim();
      committedDiff = runGit(['diff'], wt.path);
    } catch { /* ignore */ }
  }

  const truncated = committedDiff.length > MAX_DIFF_CHARS;
  const boundedDiff = truncated
    ? committedDiff.slice(0, MAX_DIFF_CHARS) + '\n... [diff truncated]'
    : committedDiff;

  return {
    id: wt.id,
    path: wt.path,
    branch: wt.branch,
    changedFiles: [...changedSet],
    uncommittedFiles,
    stat: safeDisplay(stat),
    diff: safeDisplay(boundedDiff),
    truncated
  };
}

export function mergeWorktree(
  dir: string,
  worktreeId: string,
  options: {
    squash?: boolean | undefined;
    commitMessage?: string | undefined;
    autoCommit?: boolean | undefined;
    cleanup?: boolean | undefined;
  } = {}
): WorktreeMergeResult {
  const repoRoot = resolveGitRepoRoot(dir);
  if (!repoRoot) throw new Error('Target workspace is not inside a valid Git repository.');
  const wt = findManagedWorktree(repoRoot, worktreeId);
  if (!wt.branch) {
    throw new Error(`Worktree "${wt.id}" is detached and has no branch to merge.`);
  }

  // Commit any uncommitted changes inside the isolated worktree first
  const wtStatus = runGit(['status', '--porcelain'], wt.path).trim();
  if (wtStatus && options.autoCommit !== false) {
    runGit(['add', '--all'], wt.path);
    const msg = typeof options.commitMessage === 'string' && options.commitMessage.trim()
      ? options.commitMessage.trim().slice(0, 120)
      : `worktree:${wt.id}`;
    runGit(['commit', '-m', msg], wt.path);
  }

  // Refuse to merge into a dirty parent working tree
  const parentDirty = runGit(['status', '--porcelain'], repoRoot).trim();
  if (parentDirty) {
    return {
      merged: false,
      conflict: false,
      branch: wt.branch,
      summary: 'Parent working tree has uncommitted changes; commit or stash them before merging a worktree.',
      error: 'Parent working tree is dirty.'
    };
  }

  try {
    if (options.squash) {
      runGit(['merge', '--squash', wt.branch], repoRoot);
      const staged = runGit(['diff', '--cached', '--stat'], repoRoot).trim();
      if (staged) {
        const msg = typeof options.commitMessage === 'string' && options.commitMessage.trim()
          ? options.commitMessage.trim().slice(0, 120)
          : `merge:${wt.id}`;
        runGit(['commit', '-m', msg], repoRoot);
      }
    } else {
      runGit(['merge', '--no-edit', wt.branch], repoRoot);
    }
  } catch (err: unknown) {
    // Abort conflict cleanly so the parent repo is never left broken
    try { runGit(['merge', '--abort'], repoRoot); } catch { /* ignore */ }
    try { runGit(['reset', '--merge'], repoRoot); } catch { /* ignore */ }
    return {
      merged: false,
      conflict: true,
      branch: wt.branch,
      summary: `Merge conflict merging "${wt.branch}" — aborted cleanly; primary branch unchanged.`,
      error: gitErrorDetail(err)
    };
  }

  if (options.cleanup) {
    removeWorktree(repoRoot, wt.id, { force: true, deleteBranch: true });
  }

  return {
    merged: true,
    conflict: false,
    branch: wt.branch,
    summary: `Cleanly merged worktree "${wt.id}" (${wt.branch}) into primary workspace.`
  };
}

export function removeWorktree(
  dir: string,
  worktreeId: string,
  options: { force?: boolean | undefined; deleteBranch?: boolean | undefined } = {}
): { removed: boolean; branchDeleted: boolean } {
  const repoRoot = resolveGitRepoRoot(dir);
  if (!repoRoot) throw new Error('Target workspace is not inside a valid Git repository.');
  const wt = findManagedWorktree(repoRoot, worktreeId);

  const removeArgs = ['worktree', 'remove'];
  if (options.force !== false) removeArgs.push('--force');
  removeArgs.push(wt.path);
  try {
    runGit(removeArgs, repoRoot);
  } catch (err: unknown) {
    throw new Error(`Failed to remove worktree "${wt.id}": ${gitErrorDetail(err)}`);
  }
  try { runGit(['worktree', 'prune'], repoRoot); } catch { /* ignore */ }

  let branchDeleted = false;
  if (options.deleteBranch !== false && wt.branch && wt.branch.startsWith(BRANCH_PREFIX)) {
    try {
      runGit(['branch', '-D', wt.branch], repoRoot);
      branchDeleted = true;
    } catch {
      branchDeleted = false;
    }
  }
  return { removed: true, branchDeleted };
}

export function pruneManagedWorktrees(dir: string): { pruned: number } {
  const repoRoot = resolveGitRepoRoot(dir);
  if (!repoRoot) return { pruned: 0 };
  try { runGit(['worktree', 'prune'], repoRoot); } catch { /* ignore */ }
  const container = path.join(repoRoot, WORKTREE_CONTAINER_DIR);
  if (!fs.existsSync(container)) return { pruned: 0 };

  const activePaths = new Set(listWorktrees(repoRoot).map((w) => path.resolve(w.path)));
  let pruned = 0;
  try {
    const entries = fs.readdirSync(container, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink() || !entry.isDirectory()) continue;
      const full = path.resolve(container, entry.name);
      if (!activePaths.has(full)) {
        fs.rmSync(full, { recursive: true, force: true });
        pruned++;
      }
    }
  } catch { /* ignore */ }
  return { pruned };
}
