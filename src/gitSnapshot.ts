// Shadow-git checkpoint backend.
//
// ZERO-MALWARE: every git invocation goes through runGit(), which uses execFile
// with an ARRAY of arguments. There is no shell anywhere in this file, and no
// argument is ever built by string concatenation.

import { execFileSync, execFile, type ExecFileSyncOptionsWithStringEncoding, type ExecFileOptionsWithStringEncoding } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { causyneHome } from './utils/paths.js';
import { isPhysicalPathAllowed } from './agent/workspaceBoundary.js';
import { isBlockedWorkspaceRoot } from './sandboxPolicy.js';

export type GitChangeStatus = 'added' | 'deleted' | 'modified' | 'binary';

export interface GitPreviewChange {
  path: string;
  status: GitChangeStatus;
  additions: number;
  deletions: number;
  patch: string;
}

/** A git call that hangs must not hang a task. */
const GIT_TIMEOUT_MS = 20000;

/** Untracked files above this are excluded rather than stored. */
const MAX_UNTRACKED_BYTES = 2 * 1024 * 1024;
const GIT_SHA_PATTERN = /^[0-9a-f]{40,64}$/i;

function isValidGitSha(sha: unknown): sha is string {
  return typeof sha === 'string' && GIT_SHA_PATTERN.test(sha);
}

/**
 * Run git.
 *
 * `args` is an ARRAY — execFile passes it straight to execve, so no shell ever
 * parses it and a path containing a space, a quote or `$(...)` is just a path.
 * Never change this to exec() or add `shell: true`.
 */
function hardenedGitEnv(baseEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...(baseEnv ?? process.env), GIT_TERMINAL_PROMPT: '0' };
  delete env.CAUSYNE_VAULT_KEY;
  delete env.CAUSYNE_DEV_SECRET;
  delete env.GIT_EXTERNAL_DIFF;
  delete env.GIT_PAGER;
  delete env.GIT_EDITOR;
  delete env.GIT_SSH_COMMAND;
  delete env.GIT_ASKPASS;
  return env;
}

function runGit(args: string[], options: Partial<ExecFileSyncOptionsWithStringEncoding> = {}): string {
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string' || a.includes('\0'))) {
    throw new Error('git arguments must be an array of strings');
  }
  return execFileSync('git', args, {
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
    ...options,
    env: hardenedGitEnv(options.env)
  });
}

const execFileAsync = promisify(execFile);

async function runGitAsync(args: string[], options: Partial<ExecFileOptionsWithStringEncoding> = {}): Promise<string> {
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string' || a.includes('\0'))) {
    throw new Error('git arguments must be an array of strings');
  }
  const { stdout } = await execFileAsync('git', args, {
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
    ...options,
    env: hardenedGitEnv(options.env)
  });
  return String(stdout ?? '');
}

/**
 * Capture without blocking — the form the task hot path must use.
 */
export async function captureTreeAsync(worktree: string): Promise<string | null> {
  try {
    const gitDir = initShadow(worktree);
    excludeOversizedUntracked(gitDir, worktree);
    await runGitAsync(
      ['--git-dir', gitDir, '--work-tree', worktree, 'add', '--all'],
      { cwd: worktree }
    );
    const sha = (await runGitAsync(['--git-dir', gitDir, 'write-tree'])).trim();
    return isValidGitSha(sha) ? sha : null;
  } catch {
    return null;
  }
}

/** Is a usable git binary on PATH? Cached — the answer cannot change mid-run. */
let gitAvailable: boolean | null = null;
export function isGitAvailable(): boolean {
  if (gitAvailable !== null) return gitAvailable;
  try {
    runGit(['--version']);
    gitAvailable = true;
  } catch {
    gitAvailable = false;
  }
  return gitAvailable;
}

/** The worktree root for `dir`, or null when it is not inside a git repository. */
export function resolveWorktree(dir: string): string | null {
  if (typeof dir !== 'string' || !dir.trim() || dir.includes('\0')) return null;
  try {
    const out = runGit(['rev-parse', '--show-toplevel'], { cwd: dir });
    const root = out.trim();
    return root ? path.resolve(root) : null;
  } catch {
    return null;
  }
}

/** Where this worktree's shadow repository lives. */
export function shadowDirFor(worktree: string): string {
  const hash = crypto.createHash('sha256').update(path.resolve(worktree)).digest('hex').slice(0, 16);
  return path.join(causyneHome(), 'snapshot', path.basename(worktree), hash);
}

/**
 * Create (or reuse) the shadow repository for a worktree.
 *
 * Returns the --git-dir path. Safe to call repeatedly.
 */
export function initShadow(worktree: string): string {
  const gitDir = shadowDirFor(worktree);
  const alreadyInitialised = fs.existsSync(path.join(gitDir, 'HEAD'));

  if (fs.existsSync(gitDir)) {
    const stat = fs.lstatSync(gitDir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error('Refusing symlink or non-directory shadow git repository');
    }
  }
  if (!alreadyInitialised) {
    fs.mkdirSync(gitDir, { recursive: true, mode: 0o700 });
    runGit(['--git-dir', gitDir, 'init', '--bare', '--quiet']);

    // Tuning that matters on large trees, applied once at creation.
    const tuning: ReadonlyArray<readonly [string, string]> = [
      ['feature.manyFiles', 'true'],
      ['index.version', '4'],
      ['index.threads', 'true'],
      ['core.untrackedCache', 'true']
    ];
    for (const [key, value] of tuning) {
      try {
        runGit(['--git-dir', gitDir, 'config', key, value]);
      } catch {
        // Tuning is an optimisation; an older git that rejects a key must not
        // stop the checkpoint from being taken.
      }
    }
  }

  runGit(['--git-dir', gitDir, 'config', 'core.autocrlf', 'false']);

  const sourceObjects = path.join(worktree, '.git', 'objects');
  if (fs.existsSync(sourceObjects)) {
    try {
      const infoDir = path.join(gitDir, 'objects', 'info');
      fs.mkdirSync(infoDir, { recursive: true });
      fs.writeFileSync(path.join(infoDir, 'alternates'), `${sourceObjects}\n`, 'utf8');
    } catch {
      // best-effort alternates setup
    }
  }

  if (!alreadyInitialised) {
    const sourceIndex = path.join(worktree, '.git', 'index');
    if (fs.existsSync(sourceIndex)) {
      try {
        fs.copyFileSync(sourceIndex, path.join(gitDir, 'index'));
      } catch {
        // best-effort index reuse
      }
    }
  }

  return gitDir;
}

/**
 * Exclude untracked files too large to be worth storing.
 * Written into the SHADOW repo's info/exclude, never the user's .gitignore.
 */
function excludeOversizedUntracked(gitDir: string, worktree: string): void {
  let listing = '';
  try {
    listing = runGit(
      ['--git-dir', gitDir, '--work-tree', worktree, 'ls-files', '--others', '--exclude-standard', '-z'],
      { cwd: worktree }
    );
  } catch {
    return;
  }

  const oversized: string[] = [];
  for (const rel of listing.split('\0')) {
    if (!rel) continue;
    try {
      const stat = fs.statSync(path.join(worktree, rel));
      if (stat.isFile() && stat.size > MAX_UNTRACKED_BYTES) oversized.push(rel);
    } catch {
      // skip inaccessible entry
    }
  }
  if (oversized.length === 0) return;

  try {
    const infoDir = path.join(gitDir, 'info');
    fs.mkdirSync(infoDir, { recursive: true });
    fs.writeFileSync(path.join(infoDir, 'exclude'), `${oversized.join('\n')}\n`, 'utf8');
  } catch {
    // best-effort exclude write
  }
}

/**
 * Capture the worktree's current state.
 */
export function captureTree(worktree: string): string | null {
  try {
    const gitDir = initShadow(worktree);
    excludeOversizedUntracked(gitDir, worktree);
    runGit(['--git-dir', gitDir, '--work-tree', worktree, 'add', '--all'], { cwd: worktree });

    const sha = (runGit(['--git-dir', gitDir, 'write-tree'])).trim();
    return isValidGitSha(sha) ? sha : null;
  } catch {
    return null;
  }
}

/**
 * What restoring `files` would change — WITHOUT touching the worktree.
 */
export function previewRestore(worktree: string, fromTree: string): GitPreviewChange[] {
  if (!isValidGitSha(fromTree)) return [];
  const gitDir = initShadow(worktree);
  const tempIndex = path.join(gitDir, `preview-${crypto.randomUUID()}.index`);
  const env = { ...process.env, GIT_INDEX_FILE: tempIndex };

  try {
    const current = captureTree(worktree);
    if (!current) return [];

    runGit(['--git-dir', gitDir, 'read-tree', current], { env });
    const raw = runGit(
      ['--git-dir', gitDir, 'diff', '--numstat', '--find-renames', current, fromTree],
      { env }
    );

    const changes: GitPreviewChange[] = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const parts = line.split('\t');
      const added = parts[0] ?? '';
      const removed = parts[1] ?? '';
      const file = parts[2] ?? '';
      if (!file) continue;

      let patch = '';
      try {
        patch = runGit(
          ['--git-dir', gitDir, 'diff', '--unified=3', current, fromTree, '--', file],
          { env }
        );
      } catch {
        // A binary file has no textual patch; the counts still describe it.
      }

      changes.push({
        path: file,
        status: added === '-' && removed === '-' ? 'binary' : classify(added, removed),
        additions: added === '-' ? 0 : Number(added) || 0,
        deletions: removed === '-' ? 0 : Number(removed) || 0,
        patch
      });
    }
    return changes;
  } finally {
    try { fs.rmSync(tempIndex, { force: true }); } catch { /* ignore cleanup error */ }
  }
}

function classify(added: string, removed: string): GitChangeStatus {
  const a = Number(added) || 0;
  const d = Number(removed) || 0;
  if (a > 0 && d === 0) return 'added';
  if (d > 0 && a === 0) return 'deleted';
  return 'modified';
}

/**
 * Restore the worktree to `fromTree`.
 */
export function restoreTree(worktree: string, fromTree: string): void {
  if (!isValidGitSha(fromTree)) {
    throw new Error('Refusing restore: invalid git tree SHA');
  }
  const gitDir = initShadow(worktree);
  const current = captureTree(worktree);

  const toRemove: string[] = [];
  if (current) {
    let raw = '';
    try {
      raw = runGit(['--git-dir', gitDir, 'diff', '--no-renames', '--name-status', '-z', current, fromTree]);
    } catch {
      raw = '';
    }
    const parts = raw.split('\0');
    const root = path.resolve(worktree);
    let i = 0;
    while (i < parts.length) {
      const status = parts[i] ?? '';
      if (!status) { i++; continue; }
      const code = status[0];
      if (code === 'R' || code === 'C') {
        // Rename/copy records carry 3 NUL-delimited fields: status, oldPath, newPath.
        const oldRel = parts[i + 1] ?? '';
        i += 3;
        if (code === 'R' && oldRel) {
          const absolute = path.resolve(worktree, oldRel);
          if (absolute !== root && absolute.startsWith(root + path.sep)) {
            toRemove.push(absolute);
          }
        }
        continue;
      }
      const rel = parts[i + 1] ?? '';
      i += 2;
      if (code !== 'D' || !rel) continue;

      const absolute = path.resolve(worktree, rel);
      if (absolute !== root && !absolute.startsWith(root + path.sep)) continue;
      toRemove.push(absolute);
    }
  }

  runGit(
    ['--git-dir', gitDir, '--work-tree', worktree, 'checkout', fromTree, '--', '.'],
    { cwd: worktree }
  );

  for (const absolute of toRemove) {
    try {
      if (!isPhysicalPathAllowed(absolute, [worktree], false)) continue;
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        fs.unlinkSync(absolute);
      } else if (stat.isFile()) {
        fs.rmSync(absolute, { force: true });
      }
    } catch {
      // ignore cleanup error
    }
  }
}

/** Retention: the shadow repo prunes itself rather than growing forever. */
export function pruneShadow(worktree: string): void {
  try {
    const gitDir = initShadow(worktree);
    runGit(['--git-dir', gitDir, 'gc', '--prune=7.days', '--quiet']);
  } catch {
    // best-effort prune
  }
}
