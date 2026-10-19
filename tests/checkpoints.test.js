// P2 — the checkpoint / undo store.
//
// What these pin down:
//  * undo restores the state a file had BEFORE the task, not before the last write
//  * undo of a created file removes it
//  * undo rewinds the CONVERSATION too — restoring files while chat_history still
//    claims the edits happened leaves the agent believing in a disk state that no
//    longer exists, and it will "fix" a file it thinks it already wrote
//  * restore refuses to write through a symlink or a hardlink (a restore writes
//    attacker-influenced paths; if the target was swapped between snapshot and
//    restore, following it writes somewhere else entirely)
//  * every entry point fails open — the safety net degrades, tasks never fail

import { test, describe, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Redirect HOME before importing: the store resolves ~/.causyne at module load.
const REAL_HOME = process.env.HOME;
const REAL_USERPROFILE = process.env.USERPROFILE;
const SANDBOX_HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-ckpt-')));
process.env.HOME = SANDBOX_HOME;
process.env.USERPROFILE = SANDBOX_HOME;
// CAUSYNE_HOME is what every store reads now; hijacking HOME redirected
// os.homedir() for the whole process and still missed the state root.
process.env.CAUSYNE_HOME = path.join(SANDBOX_HOME, '.causyne');

const {
  beginTask,
  captureBeforeMutation,
  undoTask,
  undoLast,
  undoStep,
  listGroups,
  pruneStore,
  readJournal,
  resolveToolPath,
  getStoreDir,
  getStoreStats,
  isCheckpointingEnabled,
  resolveProjectRoot
} = await import('../src/checkpoints.js');

const HISTORY_FILE = path.join(SANDBOX_HOME, '.causyne', 'memory', 'chat_history.json');

let WORK;
beforeEach(() => {
  WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-work-'));
});

after(() => {
  process.env.HOME = REAL_HOME;
  process.env.USERPROFILE = REAL_USERPROFILE;
  try { fs.rmSync(SANDBOX_HOME, { recursive: true, force: true }); } catch (e) {}
});

function uniqueTask(name) {
  return `${name}_${Math.random().toString(36).slice(2, 8)}`;
}

describe('undo: files', () => {
  test('a modified file goes back to its exact prior bytes', () => {
    const taskId = uniqueTask('modify');
    const file = path.join(WORK, 'a.txt');
    fs.writeFileSync(file, 'ORIGINAL\n');

    beginTask({ taskId, workspaceRoots: [] });
    captureBeforeMutation('fs_write', { path: file }, { taskId, step: 1 });
    fs.writeFileSync(file, 'OVERWRITTEN\n');

    const result = undoTask(taskId, { dryRun: false });
    assert.equal(result.ok, true);
    assert.equal(fs.readFileSync(file, 'utf8'), 'ORIGINAL\n');
  });

  test('a file the agent created is removed', () => {
    const taskId = uniqueTask('create');
    const file = path.join(WORK, 'new.txt');

    beginTask({ taskId, workspaceRoots: [] });
    captureBeforeMutation('fs_write', { path: file }, { taskId, step: 1 });
    fs.writeFileSync(file, 'CREATED\n');

    undoTask(taskId, { dryRun: false });
    assert.equal(fs.existsSync(file), false, 'undoing a create must remove the file');
  });

  test('a deleted file is recreated with its content', () => {
    const taskId = uniqueTask('delete');
    const file = path.join(WORK, 'gone.txt');
    fs.writeFileSync(file, 'PRECIOUS\n');

    beginTask({ taskId, workspaceRoots: [] });
    captureBeforeMutation('fs_delete', { path: file }, { taskId, step: 1 });
    fs.rmSync(file);

    undoTask(taskId, { dryRun: false });
    assert.equal(fs.readFileSync(file, 'utf8'), 'PRECIOUS\n');
  });

  test('an overwriting move snapshots BOTH ends', () => {
    const taskId = uniqueTask('move');
    const source = path.join(WORK, 'src.txt');
    const destination = path.join(WORK, 'dst.txt');
    fs.writeFileSync(source, 'SOURCE\n');
    fs.writeFileSync(destination, 'DESTINATION-WILL-BE-CLOBBERED\n');

    beginTask({ taskId, workspaceRoots: [] });
    captureBeforeMutation('fs_move', { source, destination, overwrite: true }, { taskId, step: 1 });
    fs.renameSync(source, destination);

    undoTask(taskId, { dryRun: false });
    assert.equal(fs.readFileSync(source, 'utf8'), 'SOURCE\n');
    assert.equal(fs.readFileSync(destination, 'utf8'), 'DESTINATION-WILL-BE-CLOBBERED\n',
      'the clobbered destination must come back too');
  });

  test('a file written three times in one task returns to its PRE-TASK state', () => {
    const taskId = uniqueTask('multi');
    const file = path.join(WORK, 'iter.txt');
    fs.writeFileSync(file, 'v0\n');

    beginTask({ taskId, workspaceRoots: [] });
    for (const version of ['v1', 'v2', 'v3']) {
      captureBeforeMutation('fs_write', { path: file }, { taskId, step: 1 });
      fs.writeFileSync(file, version + '\n');
    }

    undoTask(taskId, { dryRun: false });
    assert.equal(fs.readFileSync(file, 'utf8'), 'v0\n',
      'undo must reach the state before the FIRST write, not the last');
  });

  test('a dry run reports the plan and writes nothing', () => {
    const taskId = uniqueTask('dry');
    const file = path.join(WORK, 'dry.txt');
    fs.writeFileSync(file, 'BEFORE\n');

    beginTask({ taskId, workspaceRoots: [] });
    captureBeforeMutation('fs_write', { path: file }, { taskId, step: 1 });
    fs.writeFileSync(file, 'AFTER\n');

    const result = undoTask(taskId, { dryRun: true });
    assert.equal(result.dryRun, true);
    assert.ok(result.results.some(r => r.action.startsWith('would')));
    assert.equal(fs.readFileSync(file, 'utf8'), 'AFTER\n', 'a dry run must not write');
  });
});

describe('undo: the conversation is rewound with the files', () => {
  test('history captured at task start is restored by undo', () => {
    const taskId = uniqueTask('history');
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify([{ role: 'user', content: 'before the task' }]));

    beginTask({ taskId, workspaceRoots: [] });

    const file = path.join(WORK, 'h.txt');
    captureBeforeMutation('fs_write', { path: file }, { taskId, step: 1 });
    fs.writeFileSync(file, 'written\n');

    // The agent appends to history as it works.
    fs.writeFileSync(HISTORY_FILE, JSON.stringify([
      { role: 'user', content: 'before the task' },
      { role: 'assistant', content: 'I wrote h.txt' }
    ]));

    const result = undoTask(taskId, { dryRun: false });
    assert.equal(result.historyRestored, true);
    const restored = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    assert.equal(restored.length, 1, 'the conversation must rewind alongside the files');
    assert.equal(restored[0].content, 'before the task');
  });

  test('undo reports honestly when no history was captured', () => {
    const taskId = uniqueTask('nohistory');
    try { fs.rmSync(HISTORY_FILE, { force: true }); } catch (e) {}

    beginTask({ taskId, workspaceRoots: [] });
    const file = path.join(WORK, 'n.txt');
    captureBeforeMutation('fs_write', { path: file }, { taskId, step: 1 });
    fs.writeFileSync(file, 'x\n');

    const result = undoTask(taskId, { dryRun: false });
    assert.equal(result.historyAvailable, false);
    assert.equal(result.historyRestored, false);
  });
});

describe('restore refuses hostile targets', () => {
  test('a path swapped for a symlink is refused, not followed', () => {
    if (process.platform === 'win32') return;

    const taskId = uniqueTask('symlink');
    const file = path.join(WORK, 'target.txt');
    const outside = path.join(WORK, 'outside.txt');
    fs.writeFileSync(file, 'ORIGINAL\n');
    fs.writeFileSync(outside, 'MUST NOT BE TOUCHED\n');

    beginTask({ taskId, workspaceRoots: [] });
    captureBeforeMutation('fs_write', { path: file }, { taskId, step: 1 });

    // Between snapshot and restore the target becomes a link elsewhere.
    fs.rmSync(file);
    fs.symlinkSync(outside, file);

    const result = undoTask(taskId, { dryRun: false });
    const entry = result.results.find(r => r.path === file);
    assert.match(entry.action, /FAILED.*symlink/i);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'MUST NOT BE TOUCHED\n',
      'the restore must not have written through the link');
  });

  test('a hardlinked target is refused', () => {
    if (process.platform === 'win32') return;

    const taskId = uniqueTask('hardlink');
    const file = path.join(WORK, 'hard.txt');
    const alias = path.join(WORK, 'alias.txt');
    fs.writeFileSync(file, 'ORIGINAL\n');

    beginTask({ taskId, workspaceRoots: [] });
    captureBeforeMutation('fs_write', { path: file }, { taskId, step: 1 });

    fs.writeFileSync(file, 'CHANGED\n');
    fs.linkSync(file, alias);

    const result = undoTask(taskId, { dryRun: false });
    const entry = result.results.find(r => r.path === file);
    assert.match(entry.action, /FAILED.*hardlink/i);
  });
});

describe('the undo is itself undoable', () => {
  test('undoing records a restore point that reverses it', () => {
    const taskId = uniqueTask('redo');
    const file = path.join(WORK, 'r.txt');
    fs.writeFileSync(file, 'ORIGINAL\n');

    beginTask({ taskId, workspaceRoots: [] });
    captureBeforeMutation('fs_write', { path: file }, { taskId, step: 1 });
    fs.writeFileSync(file, 'AGENT VERSION\n');

    undoTask(taskId, { dryRun: false });
    assert.equal(fs.readFileSync(file, 'utf8'), 'ORIGINAL\n');

    const undoGroup = listGroups(50).find(g => g.taskId.startsWith('undo_')
      && g.fileEntries.some(e => e.path === file));
    assert.ok(undoGroup, 'an undo must leave a restore point behind');

    undoTask(undoGroup.taskId, { dryRun: false });
    assert.equal(fs.readFileSync(file, 'utf8'), 'AGENT VERSION\n', 'redo must bring the change back');
  });
});

describe('tree snapshot: covers what the per-file hook cannot see', () => {
  test('a file changed without any tool announcing it is detected as drift', () => {
    const taskId = uniqueTask('drift');
    const shellTouched = path.join(WORK, 'built-by-shell.txt');
    const tracked = path.join(WORK, 'tracked.txt');
    fs.writeFileSync(shellTouched, 'BEFORE THE TASK\n');
    fs.writeFileSync(tracked, 'T0\n');

    beginTask({ taskId, workspaceRoots: [WORK] });

    captureBeforeMutation('fs_write', { path: tracked }, { taskId, step: 1 });
    fs.writeFileSync(tracked, 'T1\n');

    // Stands in for a terminal command: it announces no path, so the per-file
    // hook never sees it.
    fs.writeFileSync(shellTouched, 'CLOBBERED BY A SHELL COMMAND\n');

    const result = undoTask(taskId, { dryRun: true });
    const drifted = (result.drift || []).flatMap(d => d.files);
    assert.ok(drifted.includes(shellTouched), 'the unannounced change must be reported as drift');
    assert.ok(!drifted.includes(tracked), 'a tool-announced change is not drift — it is already covered');
  });

  test('--full rolls back the unannounced change; the default does not', () => {
    const taskId = uniqueTask('full');
    const shellTouched = path.join(WORK, 'shell.txt');
    fs.writeFileSync(shellTouched, 'ORIGINAL\n');

    beginTask({ taskId, workspaceRoots: [WORK] });
    // Give the group at least one tracked entry so undoLast-style flows apply.
    const tracked = path.join(WORK, 'tracked2.txt');
    captureBeforeMutation('fs_write', { path: tracked }, { taskId, step: 1 });
    fs.writeFileSync(tracked, 'X\n');

    fs.writeFileSync(shellTouched, 'CHANGED BY SHELL\n');

    undoTask(taskId, { dryRun: false });
    assert.equal(fs.readFileSync(shellTouched, 'utf8'), 'CHANGED BY SHELL\n',
      'a plain undo must not silently revert changes it was never asked about');

    undoTask(taskId, { full: true, dryRun: false });
    assert.equal(fs.readFileSync(shellTouched, 'utf8'), 'ORIGINAL\n',
      '--full must roll the unannounced change back');
  });

  test('regenerable directories are never snapshotted', () => {
    const taskId = uniqueTask('ignore');
    fs.mkdirSync(path.join(WORK, 'node_modules', 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(WORK, 'node_modules', 'pkg', 'index.js'), 'x'.repeat(1000));
    fs.writeFileSync(path.join(WORK, 'real.js'), 'source\n');

    beginTask({ taskId, workspaceRoots: [WORK] });
    const tree = readJournal().filter(e => e.type === 'tree' && e.taskId === taskId)[0];

    assert.ok(tree, 'a tree entry should have been recorded');
    assert.equal(tree.skipped, null);
    assert.equal(tree.fileCount, 1, 'only the real source file should be counted');
  });
});

describe('store behaviour', () => {
  test('identical content is stored once (content addressing dedupes)', () => {
    const taskId = uniqueTask('dedup');
    const first = path.join(WORK, 'one.txt');
    const second = path.join(WORK, 'two.txt');
    fs.writeFileSync(first, 'SAME BYTES\n');
    fs.writeFileSync(second, 'SAME BYTES\n');

    const before = getStoreStats().bytes;
    beginTask({ taskId, workspaceRoots: [] });
    captureBeforeMutation('fs_write', { path: first }, { taskId, step: 1 });
    const afterFirst = getStoreStats().bytes;
    captureBeforeMutation('fs_write', { path: second }, { taskId, step: 2 });
    const afterSecond = getStoreStats().bytes;

    assert.ok(afterFirst > before, 'the first snapshot should add a blob');
    assert.equal(afterSecond, afterFirst, 'identical content must not add a second blob');
  });

  test('undoStep reverses only the most recent change', () => {
    const taskId = uniqueTask('step');
    const first = path.join(WORK, 'first.txt');
    const second = path.join(WORK, 'second.txt');
    fs.writeFileSync(first, 'A0\n');
    fs.writeFileSync(second, 'B0\n');

    beginTask({ taskId, workspaceRoots: [] });
    captureBeforeMutation('fs_write', { path: first }, { taskId, step: 1 });
    fs.writeFileSync(first, 'A1\n');
    captureBeforeMutation('fs_write', { path: second }, { taskId, step: 2 });
    fs.writeFileSync(second, 'B1\n');

    undoStep({ dryRun: false });
    assert.equal(fs.readFileSync(second, 'utf8'), 'B0\n', 'the last change is reversed');
    assert.equal(fs.readFileSync(first, 'utf8'), 'A1\n', 'the earlier change is left alone');
  });

  test('prune drops expired entries and collects unreferenced blobs', () => {
    const taskId = uniqueTask('prune');
    const file = path.join(WORK, 'p.txt');
    fs.writeFileSync(file, 'CONTENT TO BE PRUNED\n');

    beginTask({ taskId, workspaceRoots: [] });
    captureBeforeMutation('fs_write', { path: file }, { taskId, step: 1 });

    // Age the journal past the 14-day retention window.
    const journal = path.join(getStoreDir(), 'index.jsonl');
    const aged = readJournal().map(e => ({ ...e, ts: Date.now() - 20 * 24 * 60 * 60 * 1000 }));
    fs.writeFileSync(journal, aged.map(e => JSON.stringify(e)).join('\n') + '\n');

    const result = pruneStore();
    assert.ok(result.removedEntries > 0, 'expired entries should be dropped');
    assert.ok(result.removedObjects > 0, 'blobs nothing references should be collected');
    assert.equal(readJournal().length, 0);
  });
});

describe('it never breaks a task', () => {
  test('a non-mutating tool is ignored entirely', () => {
    const before = readJournal().length;
    const ids = captureBeforeMutation('fs_read', { path: '/tmp/whatever' }, { taskId: 'x', step: 1 });
    assert.deepEqual(ids, []);
    assert.equal(readJournal().length, before, 'reads must not write journal entries');
  });

  test('CAUSYNE_CHECKPOINTS=0 disables capture', async () => {
    const previous = process.env.CAUSYNE_CHECKPOINTS;
    process.env.CAUSYNE_CHECKPOINTS = '0';
    try {
      assert.equal(isCheckpointingEnabled(), false);
      assert.deepEqual(captureBeforeMutation('fs_write', { path: path.join(WORK, 'off.txt') }, { taskId: 'off' }), []);
      // beginTask is async now — only the git capture actually awaits, but the
      // return value is a promise either way.
      assert.equal(await beginTask({ taskId: 'off' }), null);
    } finally {
      if (previous === undefined) delete process.env.CAUSYNE_CHECKPOINTS;
      else process.env.CAUSYNE_CHECKPOINTS = previous;
    }
    assert.equal(isCheckpointingEnabled(), true);
  });

  test('malformed arguments are declined rather than thrown on', () => {
    assert.doesNotThrow(() => captureBeforeMutation('fs_write', null, { taskId: 't' }));
    assert.doesNotThrow(() => captureBeforeMutation('fs_write', {}, { taskId: 't' }));
    assert.doesNotThrow(() => captureBeforeMutation(undefined, { path: '/tmp/x' }, {}));
    assert.equal(resolveToolPath(undefined), null);
    assert.equal(resolveToolPath(''), null);
  });

  test('undoing an unknown task reports instead of throwing', () => {
    const result = undoTask('no_such_task_id', { dryRun: false });
    assert.equal(result.ok, false);
    assert.match(result.error, /no checkpoint group/);
  });

  test('undoLast reports cleanly when nothing has been changed', () => {
    // undoLast either finds a real group or says so; neither may throw.
    assert.doesNotThrow(() => undoLast({ dryRun: true }));
  });
});

describe('zero-malware compliance', () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const readSrc = (f) => fs.readFileSync(path.join(HERE, '..', 'src', f), 'utf8');

  /** Executable text only — prose in a comment must never fail an assertion. */
  const executable = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');

  test('ZM-04: no snapshot code reaches for a shell', () => {
    // This rule used to ban the string "git" outright, on the grounds that
    // opencode shells out to git and we must not acquire that dependency by the
    // back door. That was the wrong thing to forbid.
    //
    // The danger was never git — it is the SHELL: exec() and execSync() hand a
    // string to /bin/sh, so a filename containing `$(...)` or a backtick becomes
    // code. execFile takes an ARRAY straight to execve, and nothing in it is
    // ever parsed. That is the same fix printer.js received in v1.1.44.
    //
    // Banning git instead cost real capability: the file-copy store caps at
    // 5000 files, and a real home directory silently exceeded it and was left
    // uncovered by any rollback. So the rule now forbids the actual hazard.
    for (const file of ['checkpoints.js', 'gitSnapshot.js']) {
      const code = executable(readSrc(file));
      for (const forbidden of ['execSync', 'spawnSync', 'eval(', 'shell: true', 'shell:true']) {
        assert.ok(!code.includes(forbidden),
          `${file} must not contain "${forbidden}" — that is a shell, and a shell parses filenames`);
      }
      assert.ok(!/\bexec\s*\(/.test(code),
        `${file} must not call exec() — only execFile with an argument array`);
    }
  });

  test('ZM-04: every git argument is an array element, never concatenation', () => {
    // A concatenated argument is a shell injection waiting for a filename with a
    // space in it, even through execFile.
    const code = executable(readSrc('gitSnapshot.js'));
    const calls = code.match(/runGit\(\[[^\]]*\]/g) || [];
    assert.ok(calls.length > 0, 'gitSnapshot must actually drive git');
    for (const call of calls) {
      assert.ok(!/['"`]\s*\+|\+\s*['"`]/.test(call),
        `git arguments must not be built by concatenation: ${call}`);
      assert.ok(!/\$\{/.test(call),
        `git arguments must not be interpolated: ${call}`);
    }
  });

  test('ZM-04: runGit refuses anything that is not an array of strings', () => {
    // The guarantee is enforced at runtime too, not only by a source scan.
    const code = executable(readSrc('gitSnapshot.js'));
    assert.match(code, /Array\.isArray\(args\)/,
      'runGit must reject a non-array argument list');
    assert.match(code, /typeof a !== 'string'/,
      'and reject non-string arguments');
  });

  test('only the git backend may spawn anything', () => {
    // checkpoints.js delegates to gitSnapshot.js and otherwise stays pure: the
    // native fallback for machines without git must never acquire a subprocess
    // of its own, so there is exactly ONE file in this subsystem that can spawn
    // and exactly one function in it that builds the arguments.
    const code = executable(readSrc('checkpoints.js'));
    assert.ok(!code.includes('child_process'),
      'the store itself must not spawn — it delegates to gitSnapshot.js');

    const backend = executable(readSrc('gitSnapshot.js'));
    const spawnSites = (backend.match(/execFileSync\(/g) || []).length;
    assert.equal(spawnSites, 1,
      'every git call must go through the single runGit() argument gate');
  });
});


describe('the default must fail safe', () => {
  test('an options object with no dryRun flag writes NOTHING', () => {
    // This defaulted to `dryRun === true`, so a call that simply omitted the
    // flag — a malformed frame, a truncated payload, a new caller that forgot —
    // performed a REAL rollback over the user's files. For an operation that
    // overwrites work, the fallback has to be the one that writes nothing.
    const taskId = uniqueTask('failsafe');
    const file = path.join(WORK, 'safe.txt');
    fs.writeFileSync(file, 'ORIGINAL\n');

    beginTask({ taskId, workspaceRoots: [] });
    captureBeforeMutation('fs_write', { path: file }, { taskId, step: 1 });
    fs.writeFileSync(file, 'MODIFIED\n');

    // No dryRun key at all — the exact shape a malformed request produces.
    const result = undoTask(taskId, {});

    assert.equal(result.dryRun, true, 'a missing flag must mean preview');
    assert.equal(fs.readFileSync(file, 'utf8'), 'MODIFIED\n',
      'the file must be untouched when the intent to write was never stated');
  });

  test('writing requires saying so', () => {
    const taskId = uniqueTask('explicit');
    const file = path.join(WORK, 'explicit.txt');
    fs.writeFileSync(file, 'ORIGINAL\n');

    beginTask({ taskId, workspaceRoots: [] });
    captureBeforeMutation('fs_write', { path: file }, { taskId, step: 1 });
    fs.writeFileSync(file, 'MODIFIED\n');

    undoTask(taskId, { dryRun: false });
    assert.equal(fs.readFileSync(file, 'utf8'), 'ORIGINAL\n',
      'an explicit apply must still restore');
  });

  test('undoLast and undoStep fail safe the same way', () => {
    const taskId = uniqueTask('failsafe_last');
    const file = path.join(WORK, 'last.txt');
    fs.writeFileSync(file, 'ORIGINAL\n');

    beginTask({ taskId, workspaceRoots: [] });
    captureBeforeMutation('fs_write', { path: file }, { taskId, step: 1 });
    fs.writeFileSync(file, 'MODIFIED\n');

    assert.equal(undoLast({}).dryRun, true, 'undoLast must default to preview');
    assert.equal(undoStep({}).dryRun, true, 'undoStep must default to preview');
    assert.equal(fs.readFileSync(file, 'utf8'), 'MODIFIED\n',
      'neither entry point may write without being told to');
  });
});

describe('a rewind can touch one half without the other', () => {
  // The daemon always restored files AND rewound the conversation together.
  // The split existed inside undoTask and never reached the user, so there was
  // no way to re-ask a question without discarding work the agent got right,
  // or to drop the edits while keeping the reasoning.

  function taskWithBoth(name) {
    const taskId = uniqueTask(name);
    const file = path.join(WORK, 'code.txt');
    fs.writeFileSync(file, 'ORIGINAL\n');
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify([{ role: 'user', content: 'BEFORE' }]));

    beginTask({ taskId, workspaceRoots: [] });
    captureBeforeMutation('fs_write', { path: file }, { taskId, step: 1 });
    fs.writeFileSync(file, 'CHANGED\n');
    fs.writeFileSync(HISTORY_FILE, JSON.stringify([{ role: 'user', content: 'AFTER' }]));
    return { taskId, file };
  }

  test('scope "code" restores files and leaves the conversation alone', () => {
    const { taskId, file } = taskWithBoth('scope_code');
    const result = undoTask(taskId, { dryRun: false, scope: 'code' });

    assert.equal(fs.readFileSync(file, 'utf8'), 'ORIGINAL\n', 'files must be restored');
    assert.equal(result.historyRestored, false, 'the conversation must be left alone');
    assert.match(fs.readFileSync(HISTORY_FILE, 'utf8'), /AFTER/,
      'the chat must still say what it said');
  });

  test('scope "conversation" rewinds the chat and leaves files alone', () => {
    const { taskId, file } = taskWithBoth('scope_conv');
    const result = undoTask(taskId, { dryRun: false, scope: 'conversation' });

    assert.equal(fs.readFileSync(file, 'utf8'), 'CHANGED\n',
      'files must be untouched — this is the whole point of the option');
    assert.equal(result.historyRestored, true, 'the conversation must be rewound');
    assert.match(fs.readFileSync(HISTORY_FILE, 'utf8'), /BEFORE/);
  });

  test('no scope means BOTH, so every existing caller is unchanged', () => {
    const { taskId, file } = taskWithBoth('scope_default');
    const result = undoTask(taskId, { dryRun: false });

    assert.equal(fs.readFileSync(file, 'utf8'), 'ORIGINAL\n');
    assert.equal(result.historyRestored, true);
    assert.equal(result.scope, 'both', 'the default must be reported honestly');
  });

  test('a preview still writes nothing whatever the scope', () => {
    const { taskId, file } = taskWithBoth('scope_preview');
    for (const scope of ['code', 'conversation', 'both']) {
      undoTask(taskId, { scope });
      assert.equal(fs.readFileSync(file, 'utf8'), 'CHANGED\n',
        `a ${scope} preview must not write`);
      assert.match(fs.readFileSync(HISTORY_FILE, 'utf8'), /AFTER/,
        `a ${scope} preview must not rewind the chat`);
    }
  });
});

describe('checkpoints must cover the PROJECT, not wherever the daemon started', () => {
  // The bug that made undo useless in practice. Roots were
  // `[process.cwd(), ...workspacePaths]`, and a daemon started from the home
  // directory — which is simply what happens when you open a terminal and type
  // the command — tried to snapshot ALL of $HOME. That hit MAX_TREE_FILES and
  // was recorded as `too_many_files`, then the permission-scope fallbacks
  // captured /Users/Shared and /home: megabytes of files nobody has ever
  // edited. Every task produced a checkpoint containing nothing worth
  // restoring, so undo did nothing no matter where it was invoked.

  test('the home directory is never a snapshot root', () => {
    assert.equal(resolveProjectRoot(os.homedir()), null,
      '$HOME is a place, not a project — snapshotting it is what broke undo');
  });

  test('shared system directories are never snapshot roots', () => {
    for (const dir of ['/Users', '/home', '/Users/Shared', '/tmp', '/']) {
      assert.equal(resolveProjectRoot(dir), null, `${dir} must never be a project root`);
    }
  });

  test('a directory inside a repository resolves to the repository root', () => {
    const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-proj-')));
    try {
      fs.mkdirSync(path.join(repo, '.git'));
      // A nested package.json is the trap: stopping at the NEAREST marker would
      // scope the checkpoint to the subdirectory, which the git backend then
      // declines because it is not the repository root — and the native store
      // would take it and hit MAX_TREE_FILES on node_modules.
      const nested = path.join(repo, 'subpackage');
      fs.mkdirSync(nested);
      fs.writeFileSync(path.join(nested, 'package.json'), '{}');

      assert.equal(resolveProjectRoot(nested), repo,
        'the repository root wins, because only there does git apply .gitignore');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test('a project without git still resolves to its own marker', () => {
    const proj = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-nogit-')));
    try {
      fs.writeFileSync(path.join(proj, 'package.json'), '{}');
      const deep = path.join(proj, 'src', 'a', 'b');
      fs.mkdirSync(deep, { recursive: true });
      assert.equal(resolveProjectRoot(deep), proj);
    } finally {
      fs.rmSync(proj, { recursive: true, force: true });
    }
  });

  test('beginTask refuses a non-project root even if the caller passes one', () => {
    // Defended at BOTH ends: a checkpoint store that quietly fills with junk is
    // worse than one that honestly captures nothing.
    const taskId = uniqueTask('junk_roots');
    beginTask({ taskId, workspaceRoots: [os.homedir(), '/Users/Shared', '/home'] });

    const group = listGroups(5).find((g) => g.taskId === taskId);
    assert.deepEqual(group.trees, [],
      'none of those are projects, so none of them may be snapshotted');
  });
});
