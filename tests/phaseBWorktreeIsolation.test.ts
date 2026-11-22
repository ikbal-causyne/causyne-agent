import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createWorktree,
  inspectWorktreeDiff,
  listWorktrees,
  mergeWorktree,
  pruneManagedWorktrees,
  removeWorktree,
  resolveGitRepoRoot
} from '../src/worktreeManager.js';
import { gitWorktree } from '../src/tools/gitWorktree.js';
import { runCommand } from '../src/commands.js';

const TMP_ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-phaseb-wt-')));

after(() => {
  try {
    fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  } catch { /* ignore */ }
});

function initRepo(name: string): string {
  const dir = path.join(TMP_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@causyne.local'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Causyne Test'], { cwd: dir, stdio: 'ignore' });
  fs.writeFileSync(path.join(dir, 'base.txt'), 'line-1\nline-2\n', 'utf8');
  execFileSync('git', ['add', '--all'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
  return dir;
}

describe('Phase B2 — Isolated Git Worktree Parallel Agent Engine', () => {
  test('creates isolated worktrees, excludes .causyne-worktrees from parent git status, diffs, and merges cleanly', () => {
    const repo = initRepo('parallel-clean');
    assert.equal(resolveGitRepoRoot(repo), repo);

    const wt1 = createWorktree(repo, { name: 'alpha' });
    const wt2 = createWorktree(repo, { name: 'beta' });
    assert.ok(wt1.id.startsWith('alpha-'));
    assert.ok(wt2.id.startsWith('beta-'));

    // Primary working tree must remain completely clean!
    const parentStatus = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim();
    assert.equal(parentStatus, '', '.causyne-worktrees must be excluded via .git/info/exclude');

    // Parallel edits in separate isolated worktrees
    fs.writeFileSync(path.join(wt1.path, 'alpha.ts'), 'export const alpha = 1;\n', 'utf8');
    fs.writeFileSync(path.join(wt2.path, 'beta.ts'), 'export const beta = 2;\n', 'utf8');

    const list = listWorktrees(repo);
    assert.equal(list.filter((w) => w.managed).length, 2);

    const diff1 = inspectWorktreeDiff(repo, wt1.id);
    assert.ok(diff1.changedFiles.includes('alpha.ts'));
    assert.ok(diff1.uncommittedFiles.includes('alpha.ts'));

    const merge1 = mergeWorktree(repo, wt1.id, { cleanup: true, commitMessage: 'alpha work' });
    assert.equal(merge1.merged, true, merge1.error);
    assert.equal(merge1.conflict, false);

    const merge2 = mergeWorktree(repo, wt2.id, { squash: true, cleanup: true, commitMessage: 'beta work' });
    assert.equal(merge2.merged, true, merge2.error);

    assert.equal(fs.existsSync(path.join(repo, 'alpha.ts')), true);
    assert.equal(fs.existsSync(path.join(repo, 'beta.ts')), true);
    assert.equal(listWorktrees(repo).filter((w) => w.managed).length, 0);
  });

  test('aborts conflicting worktree merge cleanly without corrupting primary branch', () => {
    const repo = initRepo('conflict-abort');
    const wt1 = createWorktree(repo, { name: 'c1' });
    const wt2 = createWorktree(repo, { name: 'c2' });

    fs.writeFileSync(path.join(wt1.path, 'base.txt'), 'change-from-worker-1\nline-2\n', 'utf8');
    fs.writeFileSync(path.join(wt2.path, 'base.txt'), 'change-from-worker-2\nline-2\n', 'utf8');

    const m1 = mergeWorktree(repo, wt1.id, { cleanup: true });
    assert.equal(m1.merged, true);

    const m2 = mergeWorktree(repo, wt2.id, { cleanup: false });
    assert.equal(m2.merged, false);
    assert.equal(m2.conflict, true);

    // Primary repo must NOT be left in MERGING / conflicted state
    const statusAfter = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim();
    assert.equal(statusAfter, '', 'primary repo must remain clean after aborted conflict merge');
    assert.equal(fs.readFileSync(path.join(repo, 'base.txt'), 'utf8'), 'change-from-worker-1\nline-2\n');

    const rem = removeWorktree(repo, wt2.id, { deleteBranch: true });
    assert.equal(rem.removed, true);
    assert.equal(rem.branchDeleted, true);
    assert.equal(pruneManagedWorktrees(repo).pruned, 0);
  });

  test('git.worktree tool and /worktree slash command reject invalid refs/ids and execute lifecycle cleanly', async () => {
    const repo = initRepo('tool-and-cmd');

    const badRef = await gitWorktree.execute({ action: 'create', baseRef: '--upload-pack=evil' }, { workspaceRoot: repo });
    assert.equal(badRef.success, false);

    const badId = await gitWorktree.execute({ action: 'remove', worktreeId: '../escape' }, { workspaceRoot: repo });
    assert.equal(badId.success, false);

    const createdRes = await gitWorktree.execute({ action: 'create', name: 'toolwt' }, { workspaceRoot: repo });
    assert.equal(createdRes.success, true, createdRes.error);
    const created = JSON.parse(createdRes.output || '{}');

    const cmdList = await runCommand('worktree', ['list'], { surface: 'terminal', loop: { workspaceRoot: repo } as any });
    assert.equal(cmdList.ok, true, cmdList.output);
    assert.match(cmdList.output || '', new RegExp(created.id));

    const remRes = await gitWorktree.execute({ action: 'remove', worktreeId: created.id }, { workspaceRoot: repo });
    assert.equal(remRes.success, true);
  });
});
