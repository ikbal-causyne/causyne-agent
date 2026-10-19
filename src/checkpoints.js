

import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import * as gitBackend from './gitSnapshot.js';
import { unifiedDiff, looksBinary } from './textDiff.js';
import { causyneHome } from './utils/paths.js';
import { getActiveSessionId, SESSION_DIR } from './sessionStore.js';

/**
 * Diagnostics, off by default.
 *
 * These were console.warn, which writes to a terminal the chat prompt is
 * repainting a live region into — an uncontrolled second writer that leaves the
 * prompt's row accounting describing a block that has moved. Housekeeping that
 * skipped is not news to the person using Causyne; it is news to whoever is
 * debugging it.
 */
function debugLog(message) {
  if (process.env.CAUSYNE_DEBUG !== '1') return;
  process.stderr.write(`[causyne] ${message}\n`);
}


const STORE_DIR = path.join(causyneHome(), 'checkpoints');
const OBJECTS_DIR = path.join(STORE_DIR, 'objects');
const JOURNAL_FILE = path.join(STORE_DIR, 'index.jsonl');
const STAT_CACHE_FILE = path.join(STORE_DIR, 'stat-cache.json');

// The LEGACY single global conversation. Kept only so a journal entry written
// before sessions existed can still be restored.
const HISTORY_FILE = path.join(causyneHome(), 'memory', 'chat_history.json');

/**
 * The conversation file undo must snapshot and restore.
 *
 * THE REGRESSION THIS FIXES. Undo is session-level BY DESIGN: restoring files
 * while the conversation still claims the edits happened leaves the model
 * reasoning about a disk state that no longer exists. That is the whole reason
 * the history is captured at all.
 *
 * Chat history then moved out of one global `memory/chat_history.json` into per
 * session files under `sessions/`, and `migrateLegacyHistory()` RENAMES the old
 * file to `.migrated`. This module was never told. So `fs.existsSync(
 * HISTORY_FILE)` became permanently false, `history` was recorded as null, and
 * **the conversation rewind silently stopped happening** — undo restored the
 * files and left the agent believing in edits that were gone.
 *
 * It survived the test suite because tests/checkpoints.test.js builds this path
 * itself and writes the file before asserting. A test that creates the world it
 * measures proves nothing about production.
 */
function activeHistoryFile() {
  try {
    const id = getActiveSessionId();
    if (id) {
      const safe = String(id).replace(/[^a-zA-Z0-9_-]/g, '');
      if (safe) return path.join(SESSION_DIR, `${safe}.json`);
    }
  } catch (e) { /* fall through to the legacy file */ }
  return HISTORY_FILE;
}

// Retention. Generous enough that yesterday's mistake is still undoable, bounded
// enough that the store cannot grow without limit.
const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_STORE_BYTES = 512 * 1024 * 1024;
const MAX_JOURNAL_ENTRIES = 4000;

// A single file above this is recorded but not stored: snapshotting a 200 MB
// asset on every write would turn the safety net into a disk problem.
const MAX_FILE_BYTES = 16 * 1024 * 1024;

// Whole-workspace snapshot budgets. Exceeding either records an honest "skipped"
// rather than half a snapshot that would restore into an inconsistent tree.
const MAX_TREE_FILES = 5000;
const MAX_TREE_BYTES = 64 * 1024 * 1024;
const MAX_TREE_FILE_BYTES = 2 * 1024 * 1024;

// Directories never worth snapshotting: regenerable, and they dwarf the source.
const IGNORED_DIRECTORIES = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', 'target',
  '.next', '.nuxt', '.svelte-kit', '.turbo', '.cache', '.parcel-cache',
  'venv', '.venv', '__pycache__', '.pytest_cache', '.mypy_cache',
  'vendor', 'Pods', '.gradle', '.idea', '.vscode', 'coverage',
  '.causyne'
]);

/** Which argument of each mutating tool names the file it is about to change. */
const MUTATING_TOOL_PATHS = {
  fs_write: ['path'],
  fs_edit: ['path'],
  MultiEdit: ['file_path'],
  fs_delete: ['path'],
  // An overwrite move clobbers the destination, so both ends need a snapshot.
  fs_move: ['source', 'destination']
};

export function isCheckpointingEnabled() {
  return process.env.CAUSYNE_CHECKPOINTS !== '0';
}

function ensureStore() {
  if (!fs.existsSync(OBJECTS_DIR)) {
    fs.mkdirSync(OBJECTS_DIR, { recursive: true, mode: 0o700 });
  }
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function objectPath(hash) {
  return path.join(OBJECTS_DIR, hash.slice(0, 2), hash);
}

/**
 * Store bytes under their own hash. Identical content is stored once, so a file
 * edited ten times across three distinct states costs three blobs.
 */
function writeObject(buffer) {
  const hash = sha256(buffer);
  const target = objectPath(hash);
  if (fs.existsSync(target)) return hash; // already have it

  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  // Write-then-rename: a crash mid-write must never leave a truncated blob
  // sitting under a hash that claims to describe the full content.
  const temp = `${target}.tmp_${process.pid}_${Date.now()}`;
  fs.writeFileSync(temp, buffer, { mode: 0o600 });
  fs.renameSync(temp, target);
  return hash;
}

function readObject(hash) {
  return fs.readFileSync(objectPath(hash));
}

/** Expand `~` exactly the way every fs tool does, then resolve. */
export function resolveToolPath(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const expanded = value.replace(/^~\//, os.homedir() + '/');
  return path.resolve(expanded);
}

function appendJournal(entry) {
  fs.appendFileSync(JOURNAL_FILE, JSON.stringify(entry) + '\n', { mode: 0o600 });
}

export function readJournal() {
  if (!fs.existsSync(JOURNAL_FILE)) return [];
  const raw = fs.readFileSync(JOURNAL_FILE, 'utf8');
  const entries = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch (e) { /* skip a torn line */ }
  }
  return entries;
}

function rewriteJournal(entries) {
  const temp = `${JOURNAL_FILE}.tmp_${process.pid}`;
  fs.writeFileSync(temp, entries.map(e => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''), { mode: 0o600 });
  fs.renameSync(temp, JOURNAL_FILE);
}

function newId() {
  return `ck_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

// ---------------------------------------------------------------------------
// Snapshotting
// ---------------------------------------------------------------------------

/**
 * Snapshot one file's current state.
 * @returns {object|null} the `before` record, or null when the file is absent
 *   (which is itself meaningful: undo of a create means delete).
 */
function snapshotFile(absolutePath) {
  let stats;
  try {
    stats = fs.lstatSync(absolutePath);
  } catch (e) {
    return null; // does not exist yet
  }

  // A symlink is snapshotted as a link, never followed: following it would
  // capture (and later overwrite) a file somewhere else entirely.
  if (stats.isSymbolicLink()) {
    return { kind: 'symlink', target: fs.readlinkSync(absolutePath), mode: stats.mode & 0o777 };
  }
  if (stats.isDirectory()) {
    return { kind: 'directory', mode: stats.mode & 0o777 };
  }
  if (!stats.isFile()) {
    return { kind: 'special' };
  }
  if (stats.size > MAX_FILE_BYTES) {
    return { kind: 'file', skipped: 'too_large', size: stats.size, mode: stats.mode & 0o777 };
  }

  const buffer = fs.readFileSync(absolutePath);
  return {
    kind: 'file',
    hash: writeObject(buffer),
    size: stats.size,
    mode: stats.mode & 0o777
  };
}

/**
 * Capture the state of every file a mutating tool is about to touch.
 *
 * FAIL-OPEN BY CONTRACT: never throws, never blocks the tool call. A read-only
 * or full disk degrades the safety net; it does not fail the task.
 *
 * @returns {string[]} ids of the entries written
 */
export function captureBeforeMutation(toolName, args, meta = {}) {
  if (!isCheckpointingEnabled()) return [];
  const fields = MUTATING_TOOL_PATHS[toolName];
  if (!fields || !args) return [];

  const ids = [];
  try {
    ensureStore();
    for (const field of fields) {
      const absolutePath = resolveToolPath(args[field]);
      if (!absolutePath) continue;

      const before = snapshotFile(absolutePath);
      const entry = {
        id: newId(),
        ts: Date.now(),
        type: 'file',
        taskId: meta.taskId || 'unknown',
        step: meta.step == null ? null : meta.step,
        tool: toolName,
        path: absolutePath,
        before
      };
      appendJournal(entry);
      ids.push(entry.id);
    }
  } catch (e) {
    debugLog(`checkpoint snapshot skipped: ${e.message}`);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Workspace tree snapshot — covers changes a per-file hook cannot see
// ---------------------------------------------------------------------------

function loadStatCache() {
  try {
    return JSON.parse(fs.readFileSync(STAT_CACHE_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}

function saveStatCache(cache) {
  try {
    const temp = `${STAT_CACHE_FILE}.tmp_${process.pid}`;
    fs.writeFileSync(temp, JSON.stringify(cache), { mode: 0o600 });
    fs.renameSync(temp, STAT_CACHE_FILE);
  } catch (e) { /* the cache is an optimisation; losing it costs time, not correctness */ }
}

/**
 * Walk a workspace root and record every file's content hash.
 *
 * The stat cache is what makes this affordable to repeat: a file whose mtime and
 * size are unchanged since the last walk keeps its known hash and is never read
 * again. That is git's own trick, and it is the difference between a snapshot
 * that costs milliseconds and one that re-reads the whole tree every task.
 *
 * @returns {{manifest: object|null, skipped: string|null}}
 */
function snapshotTree(root) {
  const cache = loadStatCache();
  const files = {};
  let fileCount = 0;
  let totalBytes = 0;
  const stack = [root];

  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      continue; // unreadable directory: skip rather than abort the snapshot
    }

    for (const entry of entries) {
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue;
        stack.push(full);
        continue;
      }
      // Symlinks are recorded by target, never followed — following them can
      // walk out of the workspace entirely, or loop.
      if (entry.isSymbolicLink()) {
        try { files[full] = { kind: 'symlink', target: fs.readlinkSync(full) }; } catch (e) {}
        continue;
      }
      if (!entry.isFile()) continue;

      let stats;
      try { stats = fs.statSync(full); } catch (e) { continue; }
      if (stats.size > MAX_TREE_FILE_BYTES) continue;

      fileCount++;
      totalBytes += stats.size;
      if (fileCount > MAX_TREE_FILES) return { manifest: null, skipped: 'too_many_files' };
      if (totalBytes > MAX_TREE_BYTES) return { manifest: null, skipped: 'workspace_too_large' };

      const cached = cache[full];
      if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size
          && fs.existsSync(objectPath(cached.hash))) {
        files[full] = { kind: 'file', hash: cached.hash, size: stats.size, mode: stats.mode & 0o777 };
        continue;
      }

      try {
        const hash = writeObject(fs.readFileSync(full));
        files[full] = { kind: 'file', hash, size: stats.size, mode: stats.mode & 0o777 };
        cache[full] = { mtimeMs: stats.mtimeMs, size: stats.size, hash };
      } catch (e) { /* a file that vanished mid-walk is simply not in the snapshot */ }
    }
  }

  saveStatCache(cache);
  return { manifest: { root, files, fileCount, totalBytes }, skipped: null };
}

/**
 * Open a checkpoint group for a task: snapshot the conversation, and optionally
 * the workspace tree. Called once per task, fail-open.
 *
 * @returns {string|null} the task id the group is filed under
 */
/**
 * Files that mark a directory as a PROJECT rather than a place.
 *
 * Ordered by how strongly each implies "this is the thing being worked on".
 */
const PROJECT_MARKERS = [
  '.git', 'package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml',
  'pom.xml', 'build.gradle', 'build.gradle.kts', 'Gemfile', 'composer.json',
  'requirements.txt', 'CMakeLists.txt', 'Makefile'
];


function isSnapshotableRoot(dir) {
  if (!dir) return false;
  let resolved;
  try {
    resolved = path.resolve(dir);
  } catch (e) {
    return false;
  }

  const home = os.homedir();
  const parsed = path.parse(resolved);

  // The filesystem root, and the user's home itself.
  if (resolved === parsed.root) return false;
  if (home && path.resolve(home) === resolved) return false;

  
  // lands in one of these is not in a project, it is lost.
  const forbidden = ['/Users', '/home', '/Users/Shared', '/var', '/tmp', '/etc', '/opt', '/usr'];
  if (forbidden.includes(resolved)) return false;

  // Directly inside a system root with no project marker is not a workspace.
  return true;
}

/**
 * The project `startDir` belongs to, or null when it belongs to none.
 *
 * Walks upward for a project marker, stopping at the home directory — a marker
 * found above home would mean snapshotting somebody's whole account.
 */
export function resolveProjectRoot(startDir) {
  let current;
  try {
    current = path.resolve(startDir || process.cwd());
  } catch (e) {
    return null;
  }

  const home = os.homedir() ? path.resolve(os.homedir()) : null;
  const stop = path.parse(current).root;

  const start = current;
  let nearestMarker = null;

  for (let depth = 0; depth < 40; depth++) {
    if (!isSnapshotableRoot(current)) break;

    // A repository root wins outright, even from further up.
    //
    // Stopping at the FIRST marker found sounds right and is not: this project
    // has package.json in causyne-agent/ and .git one level above it, so the
    // nearest marker would scope the checkpoint to causyne-agent — which the git
    // backend then declines, because its root is not the repository root. The
    // native store would take it instead and immediately hit MAX_TREE_FILES on
    // node_modules. The repository root is both the true project boundary AND
    // the only root where git can apply the user's own .gitignore, which is what
    // keeps a snapshot to the files that actually matter.
    try {
      if (fs.existsSync(path.join(current, '.git'))) return current;
    } catch (e) {}

    if (!nearestMarker) {
      for (const marker of PROJECT_MARKERS) {
        if (marker === '.git') continue;
        try {
          if (fs.existsSync(path.join(current, marker))) { nearestMarker = current; break; }
        } catch (e) {}
      }
    }

    const parent = path.dirname(current);
    if (parent === current || current === stop) break;
    if (home && parent === home) break;
    current = parent;
  }

  // No repository anywhere above: fall back to the nearest ordinary project.
  return nearestMarker && isSnapshotableRoot(nearestMarker) ? nearestMarker : null;
}

/**
 * Capture `root` with the git backend, or return null to use the native store.
 *
 * Every failure path returns null rather than throwing: a checkpoint is
 * best-effort and must never be the reason a task fails to start.
 */
function gitRootFor(root) {
  try {
    if (!gitBackend.isGitAvailable()) return null;
    const worktree = gitBackend.resolveWorktree(root);
    // Only capture when the root IS the repository root. A subdirectory would
    // snapshot its whole parent project, which is not what the caller asked to
    // protect and could be enormous.
    if (!worktree || path.resolve(worktree) !== path.resolve(root)) return null;
    return worktree;
  } catch (e) {
    debugLog(`git checkpoint unavailable for ${root}: ${e.message}`);
    return null;
  }
}

/**
 * What a git-backed tree would restore, and — when asked — restoring it.
 *
 * Returns null on any git failure so the caller falls back to the native path;
 * reporting "nothing changed" because git errored would be a lie with a
 * rollback button attached to it.
 */
function gitTreeChanges(tree, undoTaskId, dryRun, applyFull) {
  try {
    const changes = gitBackend.previewRestore(tree.root, tree.gitTree);
    const driftFiles = changes.map((c) => c.path);

    if (!applyFull || dryRun) {
      return {
        driftFiles,
        results: changes.map((c) => ({
          path: path.join(tree.root, c.path),
          action: c.status === 'deleted' ? 'removed' : 'restored',
          ok: true
        }))
      };
    }

    gitBackend.restoreTree(tree.root, tree.gitTree);
    return {
      driftFiles,
      results: changes.map((c) => ({
        path: path.join(tree.root, c.path),
        action: c.status === 'deleted' ? 'removed' : 'restored',
        ok: true
      }))
    };
  } catch (e) {
    debugLog(`git restore unavailable for ${tree.root}: ${e.message}`);
    return null;
  }
}

export async function beginTask(meta = {}) {
  if (!isCheckpointingEnabled()) return null;
  const taskId = meta.taskId || 'unknown';

  try {
    ensureStore();

    // The conversation. Snapshotting the FILE rather than a message index,
    // because boundHistory() trims chat_history.json to its newest 120 messages
    // on every save — an index into that array does not survive the trimming.
    let history = null;
    const historyFile = activeHistoryFile();
    if (fs.existsSync(historyFile)) {
      const buffer = fs.readFileSync(historyFile);
      // The PATH is recorded, not just the bytes. The active session can change
      // between the task and the undo, and restoring a snapshot into whichever
      // conversation happens to be current would corrupt a different one.
      history = { hash: writeObject(buffer), size: buffer.length, file: historyFile };
    }

    appendJournal({
      id: newId(),
      ts: Date.now(),
      type: 'task_start',
      taskId,
      prompt: typeof meta.prompt === 'string' ? meta.prompt.slice(0, 200) : null,
      history
    });

    // The workspace tree, which also covers files changed by sysRun and by any
    // other tool that does not announce its paths.
    //
    // De-duplicated before the slice: only three roots are snapshotted, so a
    // repeated path spends one of those three slots twice and doubles the
    // storage for a directory already covered. The caller's list is a
    // concatenation of the working directory and the permitted scope, which
    // overlap whenever the user is working inside their own workspace — that is
    // to say, normally.
    // A root that is not a project is not worth snapshotting, and trying is
    // what made undo useless: $HOME blew past MAX_TREE_FILES and the fallbacks
    // captured directories nobody edits. Filtered HERE as well as at the caller,
    // because a checkpoint store that quietly fills with junk is worse than one
    // that honestly captures nothing.
    const roots = (meta.workspaceRoots || [])
      .filter((root, index, all) => root && all.indexOf(root) === index)
      .filter((root) => isSnapshotableRoot(root))
      .slice(0, 3);

    for (const root of roots) {
      if (!fs.existsSync(root)) continue;

      // Prefer git where the root is a repository and git is installed.
      //
      // The file-copy path below copies bytes, so it has to cap what it will
      // look at — MAX_TREE_FILES is 5000, and a real home directory exceeds it
      // and is recorded as `too_many_files`, covered by no rollback at all. Git
      // has no such ceiling: it reuses the project's own object database, so a
      // checkpoint is one `write-tree` rather than a walk-and-hash of every
      // file. The shadow repository lives in ~/.causyne and the user's own .git
      // is never written to.
      //
      // Fail-open in both directions: no git binary, or a root that is not a
      // repository, or any git error at all, and this silently uses the native
      // store exactly as before.
      // The decision is made SYNCHRONOUSLY, and only a real git capture awaits.
      //
      // Awaiting unconditionally deferred the native path too: an `async`
      // function runs synchronously only until its first await, so every caller
      // that does not itself await — which is most of them — stopped seeing the
      // journal entries this function had always written before returning.
      const gitWorktree = gitRootFor(root);
      let gitTree = null;
      if (gitWorktree) {
        // Async here and nowhere else: this runs at the start of every task,
        // and a synchronous capture can stall the foreground agent loop.
        try {
          gitTree = await gitBackend.captureTreeAsync(gitWorktree);
        } catch (e) {
          debugLog(`git capture failed for ${root}: ${e.message}`);
        }
      }
      if (gitTree) {
        appendJournal({
          id: newId(),
          ts: Date.now(),
          type: 'tree',
          taskId,
          root,
          skipped: null,
          backend: 'git',
          gitTree,
          manifestHash: null,
          fileCount: 0,
          totalBytes: 0
        });
        continue;
      }

      const { manifest, skipped } = snapshotTree(root);
      appendJournal({
        id: newId(),
        ts: Date.now(),
        type: 'tree',
        taskId,
        root,
        skipped,
        manifestHash: manifest ? writeObject(Buffer.from(JSON.stringify(manifest), 'utf8')) : null,
        fileCount: manifest ? manifest.fileCount : 0,
        totalBytes: manifest ? manifest.totalBytes : 0
      });
    }

    return taskId;
  } catch (e) {
    debugLog(`checkpoint task snapshot skipped: ${e.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Restore
// ---------------------------------------------------------------------------

/**
 * Refuse to write through anything that is not a plain file.
 *
 * A restore writes attacker-influenced paths. If the target has been replaced by
 * a symlink between snapshot and restore, following it writes wherever the link
 * points; a hardlink means the write lands in a second visible location too.
 * Both are refused rather than followed.
 */
function assertSafeTarget(absolutePath) {
  if (!path.isAbsolute(absolutePath)) {
    throw new Error(`refusing a non-absolute path: ${absolutePath}`);
  }
  if (absolutePath !== path.resolve(absolutePath)) {
    throw new Error(`refusing an unnormalised path: ${absolutePath}`);
  }

  let stats;
  try {
    stats = fs.lstatSync(absolutePath);
  } catch (e) {
    return; // absent: nothing to be tricked by
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`refusing to write through a symlink: ${absolutePath}`);
  }
  if (stats.isFile() && stats.nlink > 1) {
    throw new Error(`refusing to write through a hardlink (${stats.nlink} links): ${absolutePath}`);
  }
}

function restoreFileState(absolutePath, before) {
  assertSafeTarget(absolutePath);

  // The file did not exist when we snapshotted, so undoing means removing it.
  if (before === null) {
    if (fs.existsSync(absolutePath)) fs.rmSync(absolutePath, { recursive: true, force: true });
    return 'removed';
  }
  if (before.kind === 'symlink') {
    // lstat, not exists(): a dangling symlink fails existsSync but still
    // occupies the name and would make symlinkSync throw EEXIST.
    try { fs.lstatSync(absolutePath); fs.unlinkSync(absolutePath); } catch (e) { /* nothing there */ }
    fs.symlinkSync(before.target, absolutePath);
    return 'restored symlink';
  }
  if (before.kind === 'directory') {
    fs.mkdirSync(absolutePath, { recursive: true });
    return 'restored directory';
  }
  if (before.kind !== 'file') return 'skipped (not a regular file)';
  if (before.skipped) return `skipped (${before.skipped})`;

  const buffer = readObject(before.hash);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  // Atomic swap, matching how fs_write itself lands content.
  const temp = `${absolutePath}.causyne_restore_${process.pid}_${Date.now()}`;
  fs.writeFileSync(temp, buffer, { mode: before.mode || 0o644 });
  fs.renameSync(temp, absolutePath);
  return 'restored';
}

/**
 * Compare the workspace as it is NOW against the manifest taken at task start.
 *
 * This is what covers files changed by `sysRun` and friends: a shell command
 * announces no paths, so the per-file hook cannot see it, but the tree snapshot
 * did record the before-state of everything under the workspace root.
 *
 * @returns {{modified: string[], created: string[], deleted: string[]}|null}
 */
export function diffTree(treeEntry) {
  if (!treeEntry || !treeEntry.manifestHash || treeEntry.skipped) return null;

  let manifest;
  try {
    manifest = JSON.parse(readObject(treeEntry.manifestHash).toString('utf8'));
  } catch (e) {
    return null;
  }

  const modified = [];
  const deleted = [];
  const known = new Set(Object.keys(manifest.files || {}));

  for (const [absolutePath, record] of Object.entries(manifest.files || {})) {
    if (record.kind !== 'file') continue;
    let stats;
    try {
      stats = fs.lstatSync(absolutePath);
    } catch (e) {
      deleted.push(absolutePath);
      continue;
    }
    if (stats.isSymbolicLink() || !stats.isFile()) continue;
    if (stats.size !== record.size) { modified.push(absolutePath); continue; }
    try {
      if (sha256(fs.readFileSync(absolutePath)) !== record.hash) modified.push(absolutePath);
    } catch (e) { /* unreadable now: leave it alone rather than guess */ }
  }

  // Files that exist now but were not in the snapshot were created during the task.
  const created = [];
  const { manifest: current } = snapshotTree(manifest.root);
  if (current) {
    for (const absolutePath of Object.keys(current.files)) {
      if (!known.has(absolutePath)) created.push(absolutePath);
    }
  }

  return { modified, created, deleted, manifest };
}

/**
 * Restore every file the tree snapshot covers that has drifted since task start.
 * Deliberately NOT the default: it reverts changes the agent did not make too
 * (anything you edited yourself in another window while the task ran), so it is
 * only reached through an explicit `--full`.
 */
function restoreFromTree(treeEntry, undoTaskId, dryRun) {
  const diff = diffTree(treeEntry);
  if (!diff) return [];

  const results = [];
  const apply = (absolutePath, before, label) => {
    if (dryRun) {
      results.push({ path: absolutePath, action: `would ${label}` });
      return;
    }
    try {
      const current = snapshotFile(absolutePath);
      appendJournal({
        id: newId(), ts: Date.now(), type: 'file', taskId: undoTaskId,
        step: null, tool: 'undo-tree', path: absolutePath, before: current
      });
      results.push({ path: absolutePath, action: restoreFileState(absolutePath, before) });
    } catch (e) {
      results.push({ path: absolutePath, action: `FAILED: ${e.message}` });
    }
  };

  for (const absolutePath of [...diff.modified, ...diff.deleted]) {
    apply(absolutePath, diff.manifest.files[absolutePath], 'restore');
  }
  for (const absolutePath of diff.created) {
    apply(absolutePath, null, 'remove');
  }
  return results;
}


export function isUndoable(group) {
  if (!group) return false;
  return group.fileEntries.length > 0 || group.trees.some((tree) => !tree.skipped);
}

/** Group the journal into per-task groups, newest first. */
export function listGroups(limit = 20) {
  const entries = readJournal();
  const byTask = new Map();

  for (const entry of entries) {
    if (!byTask.has(entry.taskId)) {
      byTask.set(entry.taskId, { taskId: entry.taskId, ts: entry.ts, entries: [], prompt: null });
    }
    const group = byTask.get(entry.taskId);
    group.ts = Math.max(group.ts, entry.ts);
    if (entry.type === 'task_start' && entry.prompt) group.prompt = entry.prompt;
    group.entries.push(entry);
  }

  return [...byTask.values()]
    .sort((a, b) => b.ts - a.ts)
    .slice(0, limit)
    .map(group => ({
      ...group,
      fileEntries: group.entries.filter(e => e.type === 'file'),
      hasHistory: group.entries.some(e => e.type === 'task_start' && e.history),
      trees: group.entries.filter(e => e.type === 'tree')
    }));
}

/**
 * Roll a task back: its files AND the conversation, together.
 *
 * The restore itself is checkpointed first, under a fresh `undo_<ts>` task, so
 * an undo can itself be undone.
 */
export function undoTask(taskId, options = {}) {
  // Fail SAFE, not dangerous.
  //
  // This was `=== true`, so an options object that simply lacked the flag —
  // a malformed frame, a truncated payload, a new caller that forgot it —
  // performed a REAL rollback over the user's files. The default for an
  // operation that overwrites work must be the one that writes nothing; a
  // caller that means to write now has to say so.
  const dryRun = options.dryRun !== false;
  const groups = listGroups(1000);
  const group = groups.find(g => g.taskId === taskId);
  if (!group) return { ok: false, error: `no checkpoint group for task "${taskId}"` };

  const results = [];
  const undoTaskId = `undo_${Date.now().toString(36)}`;

  // A file touched three times in one task must end up back at the state it had
  // before the FIRST of those writes — so for each path keep the OLDEST
  // snapshot, walking the group oldest-first.
  const earliest = new Map();
  for (const entry of [...group.fileEntries].sort((a, b) => a.ts - b.ts)) {
    if (!earliest.has(entry.path)) earliest.set(entry.path, entry);
  }

  const wantsFiles = options.scope !== 'conversation';
  const wantsHistory = options.scope !== 'code';

  for (const entry of (wantsFiles ? earliest.values() : [])) {
    if (dryRun) {
      results.push({ path: entry.path, action: entry.before === null ? 'would remove' : 'would restore' });
      continue;
    }
    try {
      // Checkpoint the CURRENT state before overwriting it, so this is reversible.
      const current = snapshotFile(entry.path);
      appendJournal({
        id: newId(), ts: Date.now(), type: 'file', taskId: undoTaskId,
        step: null, tool: 'undo', path: entry.path, before: current
      });

      const action = restoreFileState(entry.path, entry.before);
      results.push({ path: entry.path, action });
    } catch (e) {
      results.push({ path: entry.path, action: `FAILED: ${e.message}` });
    }
  }

  // The conversation, rewound to the state it had when the task began.
  let historyRestored = false;
  const start = group.entries.find(e => e.type === 'task_start' && e.history);

  // The two halves of a rewind are independently selectable.
  //
  // undoTask has always restored files AND rewound the conversation together,
  // and the split existed internally without ever reaching the user. A rewind
  // that only rewinds the chat is genuinely useful — it is how you re-ask a
  // question without throwing away work the agent got right — and one that only
  // touches files keeps the reasoning while discarding the edits. An absent
  // scope means BOTH, so every existing caller is unchanged.
  if (start && !dryRun && wantsHistory) {
    // Restore into the file the snapshot was TAKEN from. Entries written before
    // sessions existed carry no path and mean the legacy global history.
    const target = start.history.file || HISTORY_FILE;
    try {
      // A journal is local and 0600, but it is still data deciding a write
      // target. Confine the restore to Causyne's own state root so a tampered or
      // hand-edited entry cannot direct it anywhere else.
      const root = causyneHome();
      const resolved = path.resolve(target);
      if (resolved !== root && !resolved.startsWith(root + path.sep)) {
        throw new Error('conversation snapshot points outside the Causyne state directory');
      }

      if (fs.existsSync(resolved)) {
        const buffer = fs.readFileSync(resolved);
        appendJournal({
          id: newId(), ts: Date.now(), type: 'task_start', taskId: undoTaskId,
          prompt: 'undo restore point',
          history: { hash: writeObject(buffer), size: buffer.length, file: resolved }
        });
      }
      assertSafeTarget(resolved);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, readObject(start.history.hash), { mode: 0o600 });
      historyRestored = true;
    } catch (e) {
      results.push({ path: target, action: `FAILED: ${e.message}` });
    }
  }

  // Workspace drift the per-file hook could not see — a shell command announces
  // no paths. Reported by default, restored only when explicitly asked, because
  // it also covers edits the user made by hand while the task ran.
  const drift = [];
  const treeResults = [];
  for (const tree of (wantsFiles ? group.trees : [])) {
    if (tree.skipped) continue;

    // A git-backed tree answers both questions from the same pair of SHAs, so
    // the preview and the restore can never disagree about what would happen.
    if (tree.backend === 'git' && tree.gitTree) {
      const gitChanges = gitTreeChanges(tree, undoTaskId, dryRun, options.full === true);
      if (gitChanges) {
        if (options.full) treeResults.push(...gitChanges.results);
        else if (gitChanges.driftFiles.length > 0) {
          drift.push({ root: tree.root, files: gitChanges.driftFiles });
        }
        continue;
      }
      // Any git failure falls through to the native path below rather than
      // silently reporting that nothing changed.
    }

    if (options.full) {
      treeResults.push(...restoreFromTree(tree, undoTaskId, dryRun));
      continue;
    }
    const diff = diffTree(tree);
    if (!diff) continue;
    const untracked = [...diff.modified, ...diff.created, ...diff.deleted]
      .filter(p => !earliest.has(p));
    if (untracked.length > 0) drift.push({ root: tree.root, files: untracked });
  }

  return {
    ok: true,
    taskId,
    dryRun,
    full: options.full === true,
    results: [...results, ...treeResults],
    historyRestored,
    historyAvailable: Boolean(start),
    scope: options.scope || 'both',
    drift,
    skippedTrees: group.trees.filter(t => t.skipped).map(t => ({ root: t.root, reason: t.skipped }))
  };
}

/** Undo the most recent task that actually changed a file. */
export function undoLast(options = {}) {
  // A task is undoable if it captured file entries OR a workspace tree.
  //
  // This used to require `fileEntries.length > 0`, which quietly discarded the
  // entire tree mechanism. The per-file hook only fires for the fs_* tools;
  // a task that did its work through the shell — `npm install`, `git checkout`,
  // a build script, `mv`, `rm` — announces no paths and produces ZERO file
  // entries. beginTask() snapshots the whole workspace tree precisely to cover
  // that case, and undoTask() already knows how to diff and restore it.
  //
  // So the store held hundreds of tree snapshots, cost megabytes to keep, and
  // `/undo` answered "no file changes have been checkpointed yet" — which was
  // not merely unhelpful, it was untrue.
  const candidates = listGroups(200).filter((group) =>
    !group.taskId.startsWith('undo_') && isUndoable(group));

  if (candidates.length === 0) {
    return { ok: false, error: 'nothing has been checkpointed yet — no task has run in this workspace' };
  }
  return undoTask(candidates[0].taskId, options);
}

/** Undo just the single most recent file mutation. */
export function undoStep(options = {}) {
  // Fail SAFE, not dangerous.
  //
  // This was `=== true`, so an options object that simply lacked the flag —
  // a malformed frame, a truncated payload, a new caller that forgot it —
  // performed a REAL rollback over the user's files. The default for an
  // operation that overwrites work must be the one that writes nothing; a
  // caller that means to write now has to say so.
  const dryRun = options.dryRun !== false;
  const entries = readJournal().filter(e => e.type === 'file' && e.tool !== 'undo');
  if (entries.length === 0) return { ok: false, error: 'no file mutation has been checkpointed yet' };

  const entry = entries[entries.length - 1];
  if (dryRun) {
    return { ok: true, dryRun, results: [{ path: entry.path, action: entry.before === null ? 'would remove' : 'would restore' }] };
  }

  try {
    const current = snapshotFile(entry.path);
    appendJournal({
      id: newId(), ts: Date.now(), type: 'file', taskId: `undo_${Date.now().toString(36)}`,
      step: null, tool: 'undo', path: entry.path, before: current
    });
    const action = restoreFileState(entry.path, entry.before);
    return { ok: true, dryRun: false, results: [{ path: entry.path, action }] };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

function directorySize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch (e) { continue; }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { stack.push(full); continue; }
      try { total += fs.statSync(full).size; } catch (e) {}
    }
  }
  return total;
}

/**
 * Drop journal entries past the retention window (or past the entry ceiling),
 * then delete every blob no surviving entry still references.
 */
export function pruneStore() {
  try {
    if (!fs.existsSync(JOURNAL_FILE)) return { removedEntries: 0, removedObjects: 0 };

    let entries = readJournal();
    const before = entries.length;
    const cutoff = Date.now() - RETENTION_MS;
    const overSize = directorySize(OBJECTS_DIR) > MAX_STORE_BYTES;

    entries = entries.filter(e => e.ts >= cutoff);
    if (entries.length > MAX_JOURNAL_ENTRIES || overSize) {
      const keep = overSize ? Math.floor(MAX_JOURNAL_ENTRIES / 2) : MAX_JOURNAL_ENTRIES;
      entries = entries.slice(-keep);
    }
    if (entries.length !== before) rewriteJournal(entries);

    // Mark and sweep: anything no surviving entry references is unreachable.
    const live = new Set();
    for (const entry of entries) {
      if (entry.before && entry.before.hash) live.add(entry.before.hash);
      if (entry.history && entry.history.hash) live.add(entry.history.hash);
      if (entry.manifestHash) {
        live.add(entry.manifestHash);
        try {
          const manifest = JSON.parse(readObject(entry.manifestHash).toString('utf8'));
          for (const record of Object.values(manifest.files || {})) {
            if (record && record.hash) live.add(record.hash);
          }
        } catch (e) { /* an unreadable manifest keeps only itself alive */ }
      }
    }

    let removedObjects = 0;
    let shards;
    try { shards = fs.readdirSync(OBJECTS_DIR); } catch (e) { shards = []; }
    for (const shard of shards) {
      const shardDir = path.join(OBJECTS_DIR, shard);
      let objects;
      try { objects = fs.readdirSync(shardDir); } catch (e) { continue; }
      for (const name of objects) {
        if (live.has(name)) continue;
        try { fs.unlinkSync(path.join(shardDir, name)); removedObjects++; } catch (e) {}
      }
      try { if (fs.readdirSync(shardDir).length === 0) fs.rmdirSync(shardDir); } catch (e) {}
    }

    return { removedEntries: before - entries.length, removedObjects };
  } catch (e) {
    debugLog(`checkpoint prune skipped: ${e.message}`);
    return { removedEntries: 0, removedObjects: 0 };
  }
}

export function getStoreDir() {
  return STORE_DIR;
}

export function getStoreStats() {
  return {
    dir: STORE_DIR,
    entries: readJournal().length,
    bytes: fs.existsSync(OBJECTS_DIR) ? directorySize(OBJECTS_DIR) : 0
  };
}

// ---------------------------------------------------------------------------
// Task diff — what REVIEW shows
// ---------------------------------------------------------------------------

/**
 * The per-file changes a task made, as a real diff.
 *
 * This is what REVIEW opens. Before it existed, REVIEW raised the ROLLBACK
 * confirmation dialog — so "let me see what happened" and "undo this" were the
 * same button, and the only way to find out what an agent had done was to be
 * asked whether you wanted to destroy it. Read-only, and it never restores.
 *
 * Both backends answer: git supplies patches directly, and the native store
 * reconstructs them from the `before` blob it already holds, so the feature
 * degrades in fidelity rather than disappearing on a machine without git.
 */
export function buildTaskDiff(taskId) {
  const group = listGroups(1000).find((g) => g.taskId === taskId);
  if (!group) {
    return { ok: false, taskId: taskId || null, error: 'no checkpoint for that task', files: [] };
  }

  const files = [];

  // 1. Git-backed trees: git computes the patch against the checkpoint tree.
  for (const tree of group.trees || []) {
    if (tree.backend !== 'git' || !tree.gitTree) continue;
    try {
      for (const change of gitBackend.previewRestore(tree.root, tree.gitTree)) {
        files.push({
          path: change.path,
          // The preview describes the RESTORE, which runs backwards. Invert it
          // so the user reads what the TASK did, which is what they asked.
          status: change.status === 'deleted' ? 'created'
            : change.status === 'added' ? 'deleted'
            : change.status,
          additions: change.deletions,
          deletions: change.additions,
          patch: change.patch || '',
          truncated: false
        });
      }
    } catch (e) {
      debugLog(`task diff unavailable for ${tree.root}: ${e.message}`);
    }
  }

  // 2. Native file entries, for anything git did not already describe.
  const seen = new Set(files.map((f) => f.path));
  for (const entry of group.fileEntries || []) {
    // The journal stores absolute paths; a diff header showing
    
    // the working directory where that makes sense, basename otherwise.
    const fromCwd = path.relative(process.cwd(), entry.path);
    const relative = (!fromCwd || fromCwd.startsWith('..'))
      ? path.basename(entry.path)
      : fromCwd;
    if (seen.has(relative)) continue;
    seen.add(relative);

    const beforeBuffer = entry.before ? readObject(entry.before.hash) : null;
    let afterBuffer = null;
    try {
      if (fs.existsSync(entry.path)) afterBuffer = fs.readFileSync(entry.path);
    } catch (e) {}

    const status = !beforeBuffer ? 'created' : !afterBuffer ? 'deleted' : 'modified';

    if (looksBinary(beforeBuffer) || looksBinary(afterBuffer)) {
      files.push({
        path: relative, status, additions: 0, deletions: 0, patch: '', truncated: true
      });
      continue;
    }

    const diff = unifiedDiff(
      beforeBuffer ? beforeBuffer.toString('utf8') : '',
      afterBuffer ? afterBuffer.toString('utf8') : '',
      relative
    );
    files.push({
      path: relative,
      status,
      additions: diff.additions,
      deletions: diff.deletions,
      patch: diff.patch,
      truncated: diff.truncated
    });
  }

  const totals = files.reduce(
    (acc, f) => ({ additions: acc.additions + f.additions, deletions: acc.deletions + f.deletions }),
    { additions: 0, deletions: 0 }
  );

  return {
    ok: true,
    taskId: group.taskId,
    prompt: group.prompt || null,
    fileCount: files.length,
    additions: totals.additions,
    deletions: totals.deletions,
    // Capped: a refactor can touch hundreds of files and this frame crosses a
    
    files: files.slice(0, 50)
  };
}
