// The shadow-git checkpoint backend.
//
// It exists because the file-copy store copies bytes and therefore has to cap
// what it will look at — MAX_TREE_FILES is 5000, and a real home directory
// exceeded it, leaving a workspace root marked `too_many_files` and covered by
// no rollback at all. Git already solves that, so this borrows opencode's
// design: a shadow repository that shares the user's object database, and a
// checkpoint that is nothing but a `write-tree` SHA.
//
// The guarantee these tests exist to defend: a PREVIEW never writes to the
// user's worktree.

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { causyneHome } from '../src/utils/paths.js';

const git = await import('../src/gitSnapshot.js');

let HAVE_GIT = false;
before(() => { HAVE_GIT = git.isGitAvailable(); });

const shadows = [];
function makeRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-git-snap-')));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@causyne'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Causyne Test'], { cwd: dir });
  shadows.push(dir);
  return dir;
}

after(() => {
  for (const dir of shadows) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {}
    try { fs.rmSync(git.shadowDirFor(dir), { recursive: true, force: true }); } catch (e) {}
  }
});

describe('the backend only claims a repository it can actually use', () => {
  test('a non-git directory resolves to no worktree', (t) => {
    if (!HAVE_GIT) return t.skip('git not installed');
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'causyne-plain-'));
    try {
      // The hybrid falls back to the native store here. Claiming a worktree that
      // does not exist would strand the user with no checkpoint at all.
      assert.equal(git.resolveWorktree(plain), null);
    } finally {
      fs.rmSync(plain, { recursive: true, force: true });
    }
  });

  test('the shadow repository never lives inside the user project', (t) => {
    if (!HAVE_GIT) return t.skip('git not installed');
    const repo = makeRepo();
    const shadow = git.shadowDirFor(repo);
    assert.ok(!shadow.startsWith(repo),
      'the user\'s own repository must never host our snapshots');
    // Under Causyne's state root, wherever CAUSYNE_HOME puts it — the previous
    // assertion pinned the literal `.causyne/snapshot/` and so tested the
    // hardcoded path rather than the property that matters.
    assert.ok(shadow.startsWith(path.join(causyneHome(), 'snapshot') + path.sep),
      'snapshots must live under the Causyne state root');
  });
});

describe('capture', () => {
  test('a capture produces a tree SHA and leaves the user repo alone', (t) => {
    if (!HAVE_GIT) return t.skip('git not installed');
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, 'a.txt'), 'ORIGINAL\n');

    const tree = git.captureTree(repo);

    assert.match(String(tree), /^[0-9a-f]{40}$/, 'a checkpoint id is a tree SHA');
    // The user's own git must be untouched: no commit, no HEAD, no staged state.
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
    assert.match(status, /a\.txt/, 'the file is still untracked in THEIR repo');
  });

  test('files the user ignores are not captured', (t) => {
    if (!HAVE_GIT) return t.skip('git not installed');
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, '.gitignore'), 'secrets.env\nnode_modules/\n');
    fs.writeFileSync(path.join(repo, 'secrets.env'), 'API_KEY=real\n');
    fs.writeFileSync(path.join(repo, 'kept.txt'), 'v1\n');

    const tree = git.captureTree(repo);
    fs.writeFileSync(path.join(repo, 'kept.txt'), 'v2\n');

    const preview = git.previewRestore(repo, tree);
    assert.ok(!preview.some((c) => c.path === 'secrets.env'),
      'an ignored file must never enter the snapshot — it is ignored for a reason');
  });
});

describe('preview writes NOTHING', () => {
  test('the worktree is byte-identical after a preview', (t) => {
    if (!HAVE_GIT) return t.skip('git not installed');
    const repo = makeRepo();
    const file = path.join(repo, 'a.txt');
    fs.writeFileSync(file, 'ORIGINAL\n');
    const tree = git.captureTree(repo);

    fs.writeFileSync(file, 'MODIFIED\nSECOND\n');
    const before = fs.readFileSync(file, 'utf8');

    git.previewRestore(repo, tree);

    assert.equal(fs.readFileSync(file, 'utf8'), before,
      'a preview that touches the worktree is not a preview');
  });

  test('the temporary index is cleaned up', (t) => {
    if (!HAVE_GIT) return t.skip('git not installed');
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, 'a.txt'), 'ORIGINAL\n');
    const tree = git.captureTree(repo);
    fs.writeFileSync(path.join(repo, 'a.txt'), 'CHANGED\n');

    git.previewRestore(repo, tree);

    const leftovers = fs.readdirSync(git.shadowDirFor(repo)).filter((f) => f.startsWith('preview-'));
    assert.deepEqual(leftovers, [], 'a preview index must not survive its preview');
  });

  test('the preview reports status, counts and a patch', (t) => {
    if (!HAVE_GIT) return t.skip('git not installed');
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, 'a.txt'), 'ORIGINAL\n');
    const tree = git.captureTree(repo);

    fs.writeFileSync(path.join(repo, 'a.txt'), 'MODIFIED\nSECOND\n');
    fs.writeFileSync(path.join(repo, 'b.txt'), 'CREATED BY THE AGENT\n');

    const preview = git.previewRestore(repo, tree);
    const byPath = Object.fromEntries(preview.map((c) => [c.path, c]));

    assert.ok(byPath['a.txt'], 'an edited file must appear');
    assert.equal(byPath['a.txt'].status, 'modified');
    assert.ok(byPath['a.txt'].patch.length > 0, 'REVIEW needs a real patch to show');

    // Restoring runs backwards: a file the agent created gets removed.
    assert.equal(byPath['b.txt'].status, 'deleted',
      'a file created after the checkpoint would be removed by the restore');
  });
});

describe('restore', () => {
  test('an approved restore returns the exact prior bytes', (t) => {
    if (!HAVE_GIT) return t.skip('git not installed');
    const repo = makeRepo();
    const file = path.join(repo, 'a.txt');
    fs.writeFileSync(file, 'ORIGINAL\n');
    const tree = git.captureTree(repo);

    fs.writeFileSync(file, 'MODIFIED\n');
    git.restoreTree(repo, tree);

    assert.equal(fs.readFileSync(file, 'utf8'), 'ORIGINAL\n');
  });
});

describe('a restore is complete, not merely mostly', () => {
  test('a file the agent created is REMOVED, not left behind', (t) => {
    if (!HAVE_GIT) return t.skip('git not installed');
    // `git checkout <tree> -- .` restores every path the tree contains and is
    // silent about every path it does not. So a file created after the
    // checkpoint survived the rollback, and "restored to the previous state"
    // quietly meant "mostly" — with the agent's new file still sitting there.
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, 'app.js'), 'ORIGINAL\n');
    const tree = git.captureTree(repo);

    fs.writeFileSync(path.join(repo, 'app.js'), 'MODIFIED\n');
    fs.writeFileSync(path.join(repo, 'generated.js'), 'THE AGENT MADE THIS\n');

    git.restoreTree(repo, tree);

    assert.equal(fs.readFileSync(path.join(repo, 'app.js'), 'utf8'), 'ORIGINAL\n');
    assert.ok(!fs.existsSync(path.join(repo, 'generated.js')),
      'a file that did not exist at the checkpoint must not exist after the restore');
  });

  test('a nested created file is removed too', (t) => {
    if (!HAVE_GIT) return t.skip('git not installed');
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, 'keep.txt'), 'KEEP\n');
    const tree = git.captureTree(repo);

    fs.mkdirSync(path.join(repo, 'src', 'deep'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'deep', 'new.js'), 'NEW\n');

    git.restoreTree(repo, tree);

    assert.ok(!fs.existsSync(path.join(repo, 'src', 'deep', 'new.js')));
    assert.equal(fs.readFileSync(path.join(repo, 'keep.txt'), 'utf8'), 'KEEP\n',
      'unrelated files must be untouched');
  });
});

describe('no shell, ever', () => {
  test('a filename that would be shell syntax is handled as a filename', (t) => {
    if (!HAVE_GIT) return t.skip('git not installed');
    // The whole reason runGit takes an argument ARRAY. Under exec() this name
    // would be parsed, and `$(...)` would run.
    const repo = makeRepo();
    const canary = path.join(repo, 'PWNED');
    const hostile = 'a $(touch PWNED) `id` ;whoami& name.txt';
    fs.writeFileSync(path.join(repo, hostile), 'CONTENT\n');

    const tree = git.captureTree(repo);

    assert.match(String(tree), /^[0-9a-f]{40}$/, 'the capture must simply succeed');
    assert.ok(!fs.existsSync(canary),
      'a filename must never be executed — this is why runGit takes an array');

    // And it is genuinely in the snapshot, not merely survived by being skipped.
    fs.rmSync(path.join(repo, hostile));
    const preview = git.previewRestore(repo, tree);
    assert.ok(preview.some((c) => c.path.includes('name.txt')),
      'the awkwardly named file must still be recoverable');
  });
});

describe('the capture must never block the event loop', () => {
  test('an async capture leaves the loop free to run timers', async (t) => {
    if (!HAVE_GIT) return t.skip('git not installed');
    // Snapshot capture runs at the start of a task. It must remain asynchronous
    // because a large repository can otherwise block timers and other runtime
    // work for several seconds.
    const repo = makeRepo();
    for (let i = 0; i < 60; i++) {
      fs.writeFileSync(path.join(repo, `f${i}.txt`), `content ${i}\n`.repeat(40));
    }

    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 5);
    try {
      const sha = await git.captureTreeAsync(repo);
      assert.match(String(sha), /^[0-9a-f]{40}$/, 'the capture must still work');
    } finally {
      clearInterval(timer);
    }

    assert.ok(ticks > 0,
      'the event loop must keep running during a capture — a blocked loop stalls other runtime work');
  });

  test('ignored files are genuinely excluded from the snapshot', (t) => {
    if (!HAVE_GIT) return t.skip('git not installed');
    // The earlier version of this passed for the wrong reason: it only checked
    // that an ignored file did not appear in a DIFF, which it would not even if
    // it had been captured, because it was identical on both sides. Meanwhile
    // `add --all --force` was adding every ignored file — node_modules
    // included — which is why the first capture took 23 seconds.
    const repo = makeRepo();
    fs.writeFileSync(path.join(repo, '.gitignore'), 'junk/\nsecret.env\n');
    fs.mkdirSync(path.join(repo, 'junk'));
    fs.writeFileSync(path.join(repo, 'junk', 'huge.bin'), 'x'.repeat(50000));
    fs.writeFileSync(path.join(repo, 'secret.env'), 'API_KEY=real\n');
    fs.writeFileSync(path.join(repo, 'kept.txt'), 'KEEP\n');

    const tree = git.captureTree(repo);

    // Ask git directly what the checkpoint tree actually contains.
    const listing = execFileSync(
      'git', ['--git-dir', git.shadowDirFor(repo), 'ls-tree', '-r', '--name-only', tree],
      { encoding: 'utf8' }
    );
    assert.match(listing, /kept\.txt/, 'real files must be captured');
    assert.ok(!listing.includes('secret.env'),
      'an ignored file must not be in the snapshot at all');
    assert.ok(!listing.includes('junk/'),
      'an ignored directory must not be in the snapshot at all');
  });
});
