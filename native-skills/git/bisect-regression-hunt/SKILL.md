---
name: bisect-regression-hunt
description: Find the commit that introduced a bug. Use when something worked before and does not now, and the cause is not obvious from a recent diff.
---

# Bisect a Regression

## Why this beats reading diffs

Bisect is a binary search over history. A thousand commits take ten tests. Reading diffs is linear and relies on recognising the bug on sight, which is exactly what has already failed.

## Workflow

1. Write the test FIRST.
   - A command that exits non-zero when the bug is present and zero when it is not. Without this you will make subjective calls at each step and the search will land on the wrong commit.
   - **Done when:** the command fails on the current commit and passes on a commit you know is good.

2. Find the bounds.
   - A known-bad commit (usually HEAD) and a known-good one. If the good end is unknown, step backwards by powers of two until the test passes.
   - **Done when:** `git bisect start <bad> <good>` is accepted.

3. Automate the search.
   - `git bisect run ./check.sh` runs the test at each step with no further input.
   - The script must exit 125 when the commit cannot be tested at all (a broken build), so bisect skips rather than mislabels it.
   - **Done when:** bisect reports a single first-bad commit.

4. Confirm the verdict.
   - Check out the reported commit and its parent, and run the test on both by hand. Bisect is only as correct as the test.
   - **Done when:** the parent passes and the reported commit fails, verified manually.

5. Reset.
   - `git bisect reset` returns to where you started. Forgetting this leaves the tree detached at an arbitrary commit.
   - **Done when:** `git status` shows the original branch.

## When the history is merges

`git bisect` handles merge commits, but a first-bad merge means the bug came from the merged branch. Re-run bisect within that branch's own commits.

## Verification

- The reported commit fails the test and its parent passes.
- The change in that commit plausibly explains the symptom.
- `git status` is back on the original branch.
