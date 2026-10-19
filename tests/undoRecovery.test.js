// Undo, and the reason it answered "nothing to undo" while holding megabytes of
// snapshots of the wrong directory.
//
// Two defects, both silent:
//
//   1. undoLast() required `fileEntries.length > 0`. The per-file hook only
//      fires for the fs_* tools, so a task that did its work through the shell
//      — npm install, git checkout, a build script, mv, rm — produced zero file
//      entries. beginTask() snapshots the whole workspace tree precisely to
//      cover that, and undoTask() already knew how to diff and restore it, but
//      the entry point discarded every such task. `/undo` replied "no file
//      changes have been checkpointed yet", which was not merely unhelpful; it
//      was false.
//
//   2. beginTask() was handed sandbox.workspacePaths — the broad default SCOPE,
//      meaning the places the agent is ALLOWED to touch. It snapshots the first
//      three, so a default install captured /Users/Shared and /home and never
//      captured the directory the user was working in. Permission and location
//      are different questions; undo needs the location.

import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-undo-'));
const REAL_HOME = process.env.HOME;
process.env.HOME = HOME;

const { beginTask, undoLast, undoTask, listGroups, captureBeforeMutation } =
  await import('../src/checkpoints.js');

const PROJECT = path.join(HOME, 'project');
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

after(() => {
  process.env.HOME = REAL_HOME;
  try { fs.rmSync(HOME, { recursive: true, force: true }); } catch (e) {}
});

beforeEach(() => {
  fs.rmSync(PROJECT, { recursive: true, force: true });
  fs.mkdirSync(PROJECT, { recursive: true });
  fs.writeFileSync(path.join(PROJECT, 'app.txt'), 'original content\n');
  fs.writeFileSync(path.join(PROJECT, 'other.txt'), 'keep me\n');
});

describe('a task that worked through the shell is still undoable', () => {
  test('undo finds it, even with zero file entries', () => {
    beginTask({ taskId: `shell_${Date.now()}`, prompt: 'build it', workspaceRoots: [PROJECT] });

    // Shell work: no fs_* tool ran, so nothing announced a path.
    fs.writeFileSync(path.join(PROJECT, 'app.txt'), 'MANGLED\n');
    fs.writeFileSync(path.join(PROJECT, 'newfile.txt'), 'created\n');
    fs.unlinkSync(path.join(PROJECT, 'other.txt'));

    const preview = undoLast({ dryRun: true });
    assert.equal(preview.ok, true,
      'this returned "no file changes have been checkpointed yet" while a full tree snapshot sat in the store');
    assert.equal(preview.results.length, 0, 'shell work announces no paths — that is the point');

    const drifted = preview.drift.reduce((total, item) => total + item.files.length, 0);
    assert.equal(drifted, 3, `the tree must see all three changes, saw ${drifted}`);
  });

  test('--full actually restores what the shell did', () => {
    beginTask({ taskId: `restore_${Date.now()}`, prompt: 'build it', workspaceRoots: [PROJECT] });
    fs.writeFileSync(path.join(PROJECT, 'app.txt'), 'MANGLED\n');
    fs.writeFileSync(path.join(PROJECT, 'newfile.txt'), 'created\n');
    fs.unlinkSync(path.join(PROJECT, 'other.txt'));

    const result = undoLast({ full: true, dryRun: false });
    assert.equal(result.ok, true);
    assert.equal(fs.readFileSync(path.join(PROJECT, 'app.txt'), 'utf8').trim(), 'original content',
      'a modified file must go back');
    assert.ok(fs.existsSync(path.join(PROJECT, 'other.txt')), 'a deleted file must come back');
    assert.ok(!fs.existsSync(path.join(PROJECT, 'newfile.txt')), 'a created file must go away');
  });

  test('a task with neither files nor a usable tree is still refused', () => {
    // The guard must not become "accept everything".
    const empty = listGroups(200).filter((group) =>
      group.fileEntries.length === 0 && group.trees.every((tree) => tree.skipped));
    for (const group of empty) {
      const result = undoTask(group.taskId, { dryRun: true });
      assert.equal(result.results.length, 0);
    }
  });

  test('file-tool changes still work — the old path is not broken', () => {
    const taskId = `files_${Date.now()}`;
    beginTask({ taskId, prompt: 'edit it', workspaceRoots: [PROJECT] });
    const target = path.join(PROJECT, 'app.txt');
    captureBeforeMutation('fs_write', { path: target }, { taskId, step: 1 });
    fs.writeFileSync(target, 'written by a tool\n');

    const result = undoTask(taskId, { dryRun: false });
    assert.ok(result.results.length > 0, 'the per-file path must still capture and restore');
    assert.equal(fs.readFileSync(target, 'utf8').trim(), 'original content');
  });
});

describe('the snapshot covers where the work happens', () => {
  test('the loop passes the working directory, not just the permitted scope', () => {
    // sandbox.workspacePaths is a PERMISSION list — on a default install it
    // begins /Users/Shared, /home, ~/Desktop. beginTask snapshots the first
    // three, so the project was never among them.
    const loop = fs.readFileSync(path.join(repoRoot, 'src', 'agentLoop.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');

    const call = loop.slice(loop.indexOf('beginCheckpointTask({'));
    const args = call.slice(0, call.indexOf('});'));

    // This used to assert process.cwd() came first, which was the right fix for
    // the bug it was written against — the permission scope was being captured
    // instead of the workspace. It is no longer the BEST answer: a daemon
    // started from the home directory has cwd = $HOME, and snapshotting a home
    // directory hits MAX_TREE_FILES and is recorded as `too_many_files`, so
    // every checkpoint held nothing worth restoring and undo did nothing
    // anywhere. The PROJECT now leads, with cwd kept as the fallback.
    assert.match(args, /workspaceRoots:\s*\[\s*resolveProjectRoot\(process\.cwd\(\)\)/,
      'the project root must lead — cwd may be a home directory');
    assert.match(args, /process\.cwd\(\)/,
      'cwd stays as the fallback when no project can be resolved');
    const scopeAt = args.indexOf('workspacePaths');
    const cwdAt = args.indexOf('process.cwd()');
    assert.ok(scopeAt === -1 || scopeAt > cwdAt,
      'the permission scope must never outrank the place work happens');
  });

  test('roots are de-duplicated so one directory is not snapshotted twice', () => {
    const taskId = `dedupe_${Date.now()}`;
    beginTask({ taskId, prompt: 'x', workspaceRoots: [PROJECT, PROJECT] });
    const group = listGroups(200).find((candidate) => candidate.taskId === taskId);
    const roots = group.trees.map((tree) => tree.root);
    assert.equal(new Set(roots).size, roots.length, 'a duplicated root doubles the storage for nothing');
  });
});
