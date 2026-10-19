---
name: merge-conflict-resolution
description: Resolve merge or rebase conflicts. Use when a merge stops with conflicts, when a rebase halts, or when conflict markers appear in a file.
---

# Merge Conflict Resolution

## Invariants

1. Never resolve a conflict by taking one side wholesale without reading both. That silently discards someone's work.
2. Never commit a file containing `<<<<<<<`, `=======` or `>>>>>>>`.
3. Run the tests after resolving. A syntactically valid resolution can still be semantically wrong.

## Workflow

1. See the shape of the conflict before editing.
   - `git status` lists the conflicted paths. `git diff --diff-filter=U` shows only the conflicting hunks.
   - **Done when:** you have the list of conflicted files and know which are code and which are generated.

2. Resolve generated files by regenerating, not by editing.
   - Lock files, build output and snapshots: check out one side, then re-run the generator.
   - `git checkout --theirs package-lock.json && npm install`
   - **Done when:** the generated file matches what the tool produces from the merged source.

3. Resolve code by understanding both intents.
   - `git log --merge -p <path>` shows the commits from each side that touched the file. Read them; the right resolution is often neither side but a combination.
   - **Done when:** the resolved hunk preserves the intent of both branches, or you can state which was deliberately dropped and why.

4. Verify before continuing.
   - `git add` the resolved files, then run the tests BEFORE `git rebase --continue` or `git commit`.
   - **Done when:** the test suite passes on the resolved tree.

## Escape hatches

- Abandon the attempt cleanly: `git merge --abort` or `git rebase --abort`. Both return to the pre-merge state and lose nothing.
- Recover a resolution you already made once: `git rerere` records and replays them.

## Verification

- `grep -rn '<<<<<<<' .` finds nothing outside test fixtures.
- The test suite passes.
- `git diff <base>...HEAD` contains no unrelated change.
