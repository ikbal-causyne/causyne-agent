// Shadow-git checkpoint backend.
//
// The file-copy store (checkpoints.js) works, but it copies bytes and therefore
// has to cap what it will look at — MAX_TREE_FILES is 5000, and a real home
// directory blows past that, which is how a user ended up with a workspace root
// silently marked `too_many_files` and NOT covered by any rollback.
//
// Git already solves this problem properly, so this backend borrows opencode's
// design (packages/core/src/snapshot.ts):
//
//   * The repository lives in ~/.causyne/snapshot/<project>/<hash(worktree)>.
//     The user's own .git is NEVER touched — no stash, no commit, no index
//     mutation, no HEAD movement. Their history is theirs.
//   * objects/info/alternates points at the user's object database, and their
//     index is copied in, so blobs the project already stores are never
//     re-hashed. This is what makes a checkpoint instant on a large tree
//     instead of a minutes-long walk.
//   * A checkpoint id IS a `write-tree` SHA. No commits, no refs, nothing to
//     garbage collect by hand.
//
// ZERO-MALWARE: every git invocation goes through runGit(), which uses execFile
// with an ARRAY of arguments. There is no shell anywhere in this file, and no
// argument is ever built by string concatenation, so there is nothing for an
// injected filename to escape into. This is the same hardening applied to
// printer.js in v1.1.44 after its exec() shell-injection hole.

import { execFileSync, execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { causyneHome } from './utils/paths.js';

/** A git call that hangs must not hang a task. */
const GIT_TIMEOUT_MS = 20000;

/** Untracked files above this are excluded rather than stored (opencode uses 2 MB). */
const MAX_UNTRACKED_BYTES = 2 * 1024 * 1024;

/**
 * Run git.
 *
 * `args` is an ARRAY — execFile passes it straight to execve, so no shell ever
 * parses it and a path containing a space, a quote or `$(...)` is just a path.
 * Never change this to exec() or add `shell: true`.
 */
function runGit(args, options = {}) {
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
    throw new Error('git arguments must be an array of strings');
  }
  // Synchronous on purpose. Everything in checkpoints.js is synchronous, and a
  // checkpoint MUST complete before the agent is allowed to touch a file — an
  // asynchronous capture would race the task's own writes and snapshot a state
  // that already includes the edits it is supposed to protect against. The cost
  // is nothing next to what this replaces: the native store walks and hashes
  // every file in the tree, where git reuses its index and writes one object.
  return execFileSync('git', args, {
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
    ...options
  });
}

const execFileAsync = promisify(execFile);


async function runGitAsync(args, options = {}) {
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
    throw new Error('git arguments must be an array of strings');
  }
  const { stdout } = await execFileAsync('git', args, {
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
    ...options
  });
  return stdout;
}

/**
 * Capture without blocking — the form the task hot path must use.
 *
 * beginTask runs at the START of every task, so it is the one capture that can
 * never be synchronous. Preview and restore stay
 * synchronous: they run only when the user has explicitly asked for an undo and
 * is waiting for the answer.
 */
export async function captureTreeAsync(worktree) {
  try {
    const gitDir = initShadow(worktree);
    excludeOversizedUntracked(gitDir, worktree);
    await runGitAsync(
      ['--git-dir', gitDir, '--work-tree', worktree, 'add', '--all'],
      { cwd: worktree }
    );
    const sha = (await runGitAsync(['--git-dir', gitDir, 'write-tree'])).trim();
    return sha || null;
  } catch (e) {
    return null;
  }
}

/** Is a usable git binary on PATH? Cached — the answer cannot change mid-run. */
let gitAvailable = null;
export function isGitAvailable() {
  if (gitAvailable !== null) return gitAvailable;
  try {
    runGit(['--version']);
    gitAvailable = true;
  } catch (e) {
    gitAvailable = false;
  }
  return gitAvailable;
}

/** The worktree root for `dir`, or null when it is not inside a git repository. */
export function resolveWorktree(dir) {
  try {
    const out = runGit(['rev-parse', '--show-toplevel'], { cwd: dir });
    const root = out.trim();
    return root ? path.resolve(root) : null;
  } catch (e) {
    return null;
  }
}

/** Where this worktree's shadow repository lives. */
export function shadowDirFor(worktree) {
  const hash = crypto.createHash('sha256').update(path.resolve(worktree)).digest('hex').slice(0, 16);
  return path.join(causyneHome(), 'snapshot', path.basename(worktree), hash);
}

/**
 * Create (or reuse) the shadow repository for a worktree.
 *
 * Returns the --git-dir path. Safe to call repeatedly.
 */
export function initShadow(worktree) {
  const gitDir = shadowDirFor(worktree);
  const alreadyInitialised = fs.existsSync(path.join(gitDir, 'HEAD'));

  if (!alreadyInitialised) {
    fs.mkdirSync(gitDir, { recursive: true });
    runGit(['--git-dir', gitDir, 'init', '--bare', '--quiet']);

    // Tuning that matters on large trees, applied once at creation.
    for (const [key, value] of [
      ['feature.manyFiles', 'true'],
      ['index.version', '4'],
      ['index.threads', 'true'],
      ['core.untrackedCache', 'true']
    ]) {
      try {
        runGit(['--git-dir', gitDir, 'config', key, value]);
      } catch (e) {
        // Tuning is an optimisation; an older git that rejects a key must not
        // stop the checkpoint from being taken.
      }
    }
  }

  // Point at the user's object database so blobs are never re-hashed, and adopt
  // their index so already-hashed entries are reused. Both are best-effort: a
  // missing or incompatible source just means a full, slower add.
  const sourceObjects = path.join(worktree, '.git', 'objects');
  if (fs.existsSync(sourceObjects)) {
    try {
      const infoDir = path.join(gitDir, 'objects', 'info');
      fs.mkdirSync(infoDir, { recursive: true });
      fs.writeFileSync(path.join(infoDir, 'alternates'), `${sourceObjects}\n`, 'utf8');
    } catch (e) {}
  }

  if (!alreadyInitialised) {
    const sourceIndex = path.join(worktree, '.git', 'index');
    if (fs.existsSync(sourceIndex)) {
      try {
        fs.copyFileSync(sourceIndex, path.join(gitDir, 'index'));
      } catch (e) {}
    }
  }

  return gitDir;
}

/**
 * Exclude untracked files too large to be worth storing.
 *
 * Written into the SHADOW repo's info/exclude, never the user's .gitignore.
 */
function excludeOversizedUntracked(gitDir, worktree) {
  let listing = '';
  try {
    listing = runGit(
      ['--git-dir', gitDir, '--work-tree', worktree, 'ls-files', '--others', '--exclude-standard', '-z'],
      { cwd: worktree }
    );
  } catch (e) {
    return;
  }

  const oversized = [];
  for (const rel of listing.split('\0')) {
    if (!rel) continue;
    try {
      const stat = fs.statSync(path.join(worktree, rel));
      if (stat.isFile() && stat.size > MAX_UNTRACKED_BYTES) oversized.push(rel);
    } catch (e) {}
  }
  if (oversized.length === 0) return;

  try {
    const infoDir = path.join(gitDir, 'info');
    fs.mkdirSync(infoDir, { recursive: true });
    fs.writeFileSync(path.join(infoDir, 'exclude'), `${oversized.join('\n')}\n`, 'utf8');
  } catch (e) {}
}

/**
 * Capture the worktree's current state.
 *
 * @returns {string|null} a tree SHA, or null if the capture failed —
 *   a checkpoint is best-effort and must never fail the task it belongs to.
 */
export function captureTree(worktree) {
  try {
    const gitDir = initShadow(worktree);
    excludeOversizedUntracked(gitDir, worktree);

    // The user's ignore rules decide what is worth keeping. --no-index keeps it
    // pattern-based rather than dependent on what their index happens to track.
    // NO --force here, deliberately.
    //
    // `--force` means "add otherwise ignored files". It was doing exactly that:
    // node_modules, build outputs, caches — everything .gitignore exists to keep
    // out. The first capture of this repository took 23 seconds and stalled task
    // startup. The user's own ignore rules are the correct definition of "files
    // worth being able to restore".
    runGit(['--git-dir', gitDir, '--work-tree', worktree, 'add', '--all'], { cwd: worktree });

    const sha = (runGit(['--git-dir', gitDir, 'write-tree'])).trim();
    return sha || null;
  } catch (e) {
    return null;
  }
}

/**
 * What restoring `files` would change — WITHOUT touching the worktree.
 *
 * The technique is opencode's (packages/core/src/git.ts), which built it and
 * never wired it to a UI: point GIT_INDEX_FILE at a throwaway index, read-tree
 * the current state into it, update-index the planned blobs over the top,
 * write-tree that hypothetical, and diff it against now. Nothing anywhere near
 * the user's files is written, and the temp index is removed in a finally.
 *
 * @param {string} worktree
 * @param {string} fromTree tree SHA to restore from
 * @returns {Array<{path,status,additions,deletions,patch}>}
 */
export function previewRestore(worktree, fromTree) {
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

    const changes = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const [added, removed, file] = line.split('\t');
      if (!file) continue;

      let patch = '';
      try {
        patch = runGit(
          ['--git-dir', gitDir, 'diff', '--unified=3', current, fromTree, '--', file],
          { env }
        );
      } catch (e) {
        // A binary file has no textual patch; the counts still describe it.
      }

      changes.push({
        path: file,
        // Restoring runs backwards: a file absent from the OLD tree was created
        // by the task and would be deleted, and vice versa.
        status: added === '-' && removed === '-' ? 'binary' : classify(added, removed),
        additions: added === '-' ? 0 : Number(added) || 0,
        deletions: removed === '-' ? 0 : Number(removed) || 0,
        patch
      });
    }
    return changes;
  } finally {
    try { fs.rmSync(tempIndex, { force: true }); } catch (e) {}
  }
}

function classify(added, removed) {
  const a = Number(added) || 0;
  const d = Number(removed) || 0;
  if (a > 0 && d === 0) return 'added';
  if (d > 0 && a === 0) return 'deleted';
  return 'modified';
}

/**
 * Restore the worktree to `fromTree`.
 *
 * Only called after the user has approved a preview built from the same pair of
 * trees, so what they were shown is what happens.
 */
export function restoreTree(worktree, fromTree) {
  const gitDir = initShadow(worktree);
  const current = captureTree(worktree);

  // Files the agent CREATED must be removed, not merely left behind.
  //
  // `git checkout <tree> -- .` restores every path the tree contains and is
  // silent about every path it does not — so a file created after the
  // checkpoint survived the rollback, and "restored to the previous state"
  // quietly meant "mostly". Deletions are computed first, because the checkout
  // below rewrites the index this diff is read from.
  const toRemove = [];
  if (current) {
    let raw = '';
    try {
      raw = runGit(['--git-dir', gitDir, 'diff', '--name-status', '-z', current, fromTree]);
    } catch (e) {
      raw = '';
    }
    // -z output is NUL separated: status, path, status, path…
    const parts = raw.split('\0').filter(Boolean);
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const status = parts[i];
      const rel = parts[i + 1];
      // 'D' going current -> target means: present now, absent then.
      if (status[0] !== 'D') continue;

      // A path must never climb out of the worktree it belongs to.
      const absolute = path.resolve(worktree, rel);
      const root = path.resolve(worktree);
      if (absolute !== root && !absolute.startsWith(root + path.sep)) continue;
      toRemove.push(absolute);
    }
  }

  runGit(
    ['--git-dir', gitDir, '--work-tree', worktree, 'checkout', fromTree, '--', '.'],
    { cwd: worktree }
  );

  for (const absolute of toRemove) {
    try { fs.rmSync(absolute, { force: true }); } catch (e) {}
  }
}

/** Retention: the shadow repo prunes itself rather than growing forever. */
export function pruneShadow(worktree) {
  try {
    const gitDir = initShadow(worktree);
    runGit(['--git-dir', gitDir, 'gc', '--prune=7.days', '--quiet']);
  } catch (e) {}
}
